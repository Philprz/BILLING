import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import {
  findInvoices,
  findInvoiceById,
  findInvoiceFiles,
  type FindInvoicesParams,
} from '../repositories/invoice.repository';
import type { InvoiceStatus } from '@pa-sap-bridge/database';
import { requireSession } from '../middleware/require-session';
import {
  uploadAttachment,
  createPurchaseDoc,
  createJournalEntry,
  findPurchaseInvoiceByNumAtCard,
  findPurchaseInvoiceByDocNum,
  attachFileToExistingPurchaseInvoice,
  patchBusinessPartnerFiscal,
  SapSlError,
  type SapPurchaseInvoiceRef,
} from '../services/sap-sl.service';
import { buildPurchaseDocPayload, buildJournalEntryPayload } from '../services/sap-invoice-builder';
import { sendPaStatus } from '../services/pa-status.service';
import {
  assertLitigeStatusOk,
  assertLiftLitigeStatusOk,
  validateLitigeMotif,
  LITIGE_MIN_MOTIF_LENGTH,
  DISPUTABLE_STATUSES,
} from '../services/litige.service';
import { resolveSapExecutionPolicy } from '../services/sap-policy.service';
import { validateInvoiceForSapPost } from '../services/sap-validation.service';
import {
  validateCachedAccount,
  isCachePopulated,
} from '../services/chart-of-accounts-cache.service';
import { searchChartOfAccounts } from '../services/sap-sl.service';
import { resolveTaxCode } from '../services/tax-code-resolver.service';
import { applyLearningAfterPost } from '../services/learning.service';
import { enrichInvoiceById, enrichPendingInvoices } from '../services/enrichment.service';
import { learnFromManualChoice } from '../services/learning.service';
import { parseInvoiceXml } from '../services/xml-parser.service';
import {
  buildPaStatusPayload,
  computeNextRetryAt,
  createAuditLog,
  createAuditLogBestEffort,
  getPaStatusRetryPolicy,
  prisma,
} from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';

const INVOICE_STATUSES = [
  'NEW',
  'TO_REVIEW',
  'READY',
  'POSTED',
  'LINKED',
  'REJECTED',
  'DISPUTED',
  'ERROR',
] as const;
const SORT_FIELDS = ['receivedAt', 'docDate', 'totalInclTax', 'status', 'supplierNameRaw'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TERMINAL_STATUSES = new Set(['POSTED', 'LINKED', 'REJECTED']);

interface PostInvoiceBody {
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  simulate?: boolean;
}

interface PatchSupplierBody {
  supplierB1Cardcode: string | null;
}

interface PatchCommentBody {
  comment: string | null;
}

// Limite SAP B1 sur Comments (PurchaseInvoice) — voir CDC §7.1.
const COMMENT_MAX_LENGTH = 254;

interface PatchLineBody {
  chosenAccountCode?: string | null;
  chosenCostCenter?: string | null;
  chosenTaxCodeB1?: string | null;
  taxCodeLockedByUser?: boolean;
  accountCodeLockedByUser?: boolean;
}

interface RejectInvoiceBody {
  reason: string;
}

interface LitigeInvoiceBody {
  motif: string;
}

interface LeverLitigeInvoiceBody {
  commentaire?: string;
}

interface RetourAReviserInvoiceBody {
  commentaire?: string;
}

interface InvoiceListQuery {
  page?: number;
  limit?: number;
  status?: string;
  paSource?: string;
  supplierCardcode?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  direction?: string;
  amountMin?: number;
  amountMax?: number;
  sortBy?: string;
  sortDir?: string;
}

interface BulkPostBody {
  ids: string[];
}

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }): {
  ipAddress: string;
  userAgent: string | null;
} {
  const userAgentHeader = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : null,
  };
}

function buildValidationErrorMessage(validationReport: {
  issues: Array<{ message: string }>;
}): string {
  if (validationReport.issues.length === 0) {
    return 'Validation SAP impossible';
  }

  if (validationReport.issues.length === 1) {
    return validationReport.issues[0].message;
  }

  return `${validationReport.issues[0].message} (+${validationReport.issues.length - 1} autre(s) erreur(s))`;
}

const ACTIVE_STATUSES: InvoiceStatus[] = ['NEW', 'TO_REVIEW', 'READY', 'ERROR'];

function parseStatusParam(raw?: string): FindInvoicesParams['status'] {
  if (!raw || raw === 'ALL') return undefined;
  if (raw === 'ACTIVE') return ACTIVE_STATUSES;
  if ((INVOICE_STATUSES as readonly string[]).includes(raw)) return raw as InvoiceStatus;
  return undefined;
}

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoices
  // Paramètres : page, limit, status, paSource, supplierCardcode,
  //              dateFrom, dateTo, search, sortBy, sortDir
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: InvoiceListQuery }>(
    '/api/invoices',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            status: { type: 'string', maxLength: 100 },
            paSource: { type: 'string', maxLength: 100 },
            supplierCardcode: { type: 'string', maxLength: 50 },
            dateFrom: { type: 'string', format: 'date' },
            dateTo: { type: 'string', format: 'date' },
            search: { type: 'string', maxLength: 100 },
            direction: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE'] },
            amountMin: { type: 'number', minimum: 0 },
            amountMax: { type: 'number', minimum: 0 },
            sortBy: { type: 'string', enum: [...SORT_FIELDS] },
            sortDir: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const params: FindInvoicesParams = {
        page,
        limit,
        status: parseStatusParam(q.status),
        paSource: q.paSource,
        supplierCardcode: q.supplierCardcode,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        search: q.search,
        direction: q.direction as FindInvoicesParams['direction'],
        amountMin: q.amountMin,
        amountMax: q.amountMax,
        sortBy: q.sortBy as FindInvoicesParams['sortBy'],
        sortDir: q.sortDir as FindInvoicesParams['sortDir'],
      };

      const { items, total } = await findInvoices(params);
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        success: true,
        data: { items, total, page, limit, totalPages },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoices/export.csv
  // Exporte toutes les factures filtrées au format CSV (UTF-8 BOM).
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: Omit<InvoiceListQuery, 'page' | 'limit' | 'sortBy' | 'sortDir'> }>(
    '/api/invoices/export.csv',
    { preHandler: requireSession },
    async (request, reply) => {
      const q = request.query;
      const { items } = await findInvoices({
        page: 1,
        limit: 5000,
        status: parseStatusParam(q.status),
        paSource: q.paSource,
        supplierCardcode: q.supplierCardcode,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        search: q.search,
        sortBy: 'docDate',
        sortDir: 'desc',
      });

      const csvEsc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header =
        'Date,Numero,Fournisseur,CardCode SAP,Montant HT,TVA,TTC,Devise,Statut,Source PA\r\n';
      const rows = items
        .map((inv) =>
          [
            inv.docDate,
            csvEsc(inv.docNumberPa),
            csvEsc(inv.supplierNameRaw),
            inv.supplierB1Cardcode ?? '',
            inv.totalExclTax,
            inv.totalTax,
            inv.totalInclTax,
            inv.currency,
            inv.status,
            inv.paSource,
          ].join(','),
        )
        .join('\r\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="factures.csv"');
      return reply.send('﻿' + header + rows);
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoices/stats/daily
  // Retourne les 30 derniers jours : nombre de factures reçues et intégrées.
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/api/invoices/stats/daily', { preHandler: requireSession }, async (_request, reply) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const invoices = await prisma.invoice.findMany({
      where: { receivedAt: { gte: cutoff } },
      select: { receivedAt: true, status: true },
    });

    const byDay = new Map<string, { received: number; posted: number }>();
    for (const inv of invoices) {
      const day = inv.receivedAt.toISOString().slice(0, 10);
      const existing = byDay.get(day) ?? { received: 0, posted: 0 };
      existing.received++;
      if (inv.status === 'POSTED') existing.posted++;
      byDay.set(day, existing);
    }

    // Fill all 30 days (including zero-count days)
    const days: { date: string; received: number; posted: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const day = d.toISOString().slice(0, 10);
      const data = byDay.get(day) ?? { received: 0, posted: 0 };
      days.push({ date: day, ...data });
    }

    return reply.send({ success: true, data: { days } });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/bulk-post
  // Intègre en masse les factures READY (mode SERVICE_INVOICE, sans simulation).
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: BulkPostBody }>(
    '/api/invoices/bulk-post',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { ids } = request.body;
      const { sapUser, sapCookieHeader } = request.sapSession!;
      const requestMeta = getRequestMeta(request);
      const results: { id: string; ok: boolean; error?: string; sapDocNum?: number }[] = [];

      // Load settings once for the whole batch
      const [taxMapSetting] = await Promise.all([
        prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } }),
      ]);
      const taxRateMap = (taxMapSetting?.value ?? {}) as Record<string, string>;

      for (const id of ids) {
        const invoice = await prisma.invoice.findUnique({
          where: { id },
          include: { files: true, lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!invoice || invoice.status !== 'READY' || !invoice.supplierB1Cardcode) {
          const reason = !invoice
            ? 'Introuvable'
            : !invoice.supplierB1Cardcode
              ? 'Fournisseur SAP non résolu'
              : `Statut "${invoice.status}" non traitable`;
          results.push({ id, ok: false, error: reason });
          continue;
        }

        try {
          const executionPolicy = resolveSapExecutionPolicy({ simulate: false });

          const validationReport = await validateInvoiceForSapPost(
            invoice,
            'SERVICE_INVOICE',
            sapCookieHeader,
            taxRateMap,
          );

          const hardErrors = validationReport.issues.filter((i) => i.code !== 'INVALID_TAX_CODE');
          if (hardErrors.length > 0) {
            results.push({ id, ok: false, error: buildValidationErrorMessage(validationReport) });
            continue;
          }

          let sapDocEntry: number;
          let sapDocNum: number;

          if (executionPolicy.effectivePostPolicy === 'simulate') {
            sapDocEntry = 99900 + Math.floor(Math.random() * 99);
            sapDocNum = sapDocEntry;
          } else {
            const docType =
              invoice.direction === 'CREDIT_NOTE' ? 'PurchaseCreditNotes' : 'PurchaseInvoices';
            const { payload, skippedLines } = buildPurchaseDocPayload(
              {
                docNumberPa: invoice.docNumberPa,
                paSource: invoice.paSource,
                paMessageId: invoice.paMessageId,
                direction: invoice.direction,
                supplierB1Cardcode: invoice.supplierB1Cardcode!,
                docDate: invoice.docDate,
                dueDate: invoice.dueDate,
                currency: invoice.currency,
                supplierNameRaw: invoice.supplierNameRaw,
              },
              invoice.lines,
              0,
              taxRateMap,
            );
            if (skippedLines.length > 0) {
              results.push({
                id,
                ok: false,
                error: `Lignes sans compte comptable : ${skippedLines.join(', ')}`,
              });
              continue;
            }
            const doc = await createPurchaseDoc(sapCookieHeader, docType, payload);
            sapDocEntry = doc.docEntry;
            sapDocNum = doc.docNum;
          }

          await prisma.invoice.update({
            where: { id },
            data: { status: 'POSTED', sapDocEntry, sapDocNum, integrationMode: 'SERVICE_INVOICE' },
          });

          applyLearningAfterPost({
            supplierB1Cardcode: invoice.supplierB1Cardcode,
            lines: invoice.lines,
            sapUser,
          }).catch(() => {});

          await createAuditLogBestEffort({
            action: 'POST_SAP',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'OK',
            payloadBefore: { status: 'READY' },
            payloadAfter: { status: 'POSTED', sapDocEntry, sapDocNum, bulkAction: true },
            ...requestMeta,
          });

          results.push({ id, ok: true, sapDocNum });
        } catch (err) {
          const message =
            err instanceof SapSlError
              ? err.sapDetail
              : err instanceof Error
                ? err.message
                : String(err);
          await prisma.invoice
            .update({ where: { id }, data: { status: 'ERROR', statusReason: message } })
            .catch(() => {});
          await createAuditLogBestEffort({
            action: 'POST_SAP',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: message,
            payloadBefore: { status: 'READY' },
            payloadAfter: { bulkAction: true },
            ...requestMeta,
          });
          results.push({ id, ok: false, error: message });
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return reply.send({ success: true, data: { results, succeeded, failed } });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/bulk-send-status
  // Renvoie le statut PA pour toutes les factures POSTED ou REJECTED sélectionnées.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: BulkPostBody }>(
    '/api/invoices/bulk-send-status',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { ids } = request.body;
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);
      const results: { id: string; ok: boolean; error?: string }[] = [];

      for (const id of ids) {
        const invoice = await prisma.invoice.findUnique({ where: { id } });
        if (!invoice || !['POSTED', 'REJECTED'].includes(invoice.status)) {
          results.push({
            id,
            ok: false,
            error: !invoice ? 'Introuvable' : `Statut "${invoice.status}" non éligible`,
          });
          continue;
        }

        try {
          const sendResult = await sendPaStatus(invoice as Parameters<typeof sendPaStatus>[0]);
          await prisma.invoice.update({
            where: { id },
            data: { paStatusSentAt: new Date() },
          });
          await createAuditLogBestEffort({
            action: 'SEND_STATUS_PA',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'OK',
            payloadAfter: { deliveryMode: sendResult.deliveryMode },
            ...requestMeta,
          });
          results.push({ id, ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await createAuditLogBestEffort({
            action: 'SEND_STATUS_PA',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: message,
            ...requestMeta,
          });
          results.push({ id, ok: false, error: message });
        }
      }

      const succeeded = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return reply.send({ success: true, data: { results, succeeded, failed } });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoices/:id
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const invoice = await findInvoiceById(request.params.id);
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      await createAuditLogBestEffort({
        action: 'VIEW_INVOICE',
        entityType: 'INVOICE',
        entityId: invoice.id,
        sapUser: request.sapSession?.sapUser ?? null,
        outcome: 'OK',
        payloadAfter: {
          docNumberPa: invoice.docNumberPa,
          paSource: invoice.paSource,
          status: invoice.status,
        },
        ...getRequestMeta(request),
      });

      return reply.send({ success: true, data: invoice });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoices/:id/files
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/files',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const files = await findInvoiceFiles(request.params.id);
      if (files === null) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }
      return reply.send({ success: true, data: files });
    },
  );

  // ── GET /api/invoices/:id/files/:fileId/content ────────────────────────────
  // Sert le contenu brut d'un fichier (XML ou PDF) depuis le disque.
  // Sécurité : vérifie que fileId appartient bien à l'invoice :id.
  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/invoices/:id/files/:fileId/content',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'fileId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            fileId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, fileId } = request.params;

      const file = await prisma.invoiceFile.findFirst({
        where: { id: fileId, invoiceId: id },
      });
      if (!file) return reply.code(404).send({ success: false, error: 'Fichier introuvable' });

      const filePath = file.path;
      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ success: false, error: 'Fichier absent du disque' });
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = ext === '.pdf' ? 'application/pdf' : 'application/xml';
      const filename = path.basename(filePath);

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `inline; filename="${filename}"`);
      return reply.send(fs.createReadStream(filePath));
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/post
  // Valide une facture READY et la crée dans SAP B1 :
  //   1. Upload de la première pièce jointe dans Attachments2
  //   2. Création du document SAP (PurchaseInvoice / CreditNote / JournalEntry)
  //   3. Mise à jour DB + audit log
  //
  // Body  : { integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY', simulate?: boolean }
  // Guard : session SAP valide (cookie pa_session)
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: PostInvoiceBody }>(
    '/api/invoices/:id/post',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['integrationMode'],
          properties: {
            integrationMode: { type: 'string', enum: ['SERVICE_INVOICE', 'JOURNAL_ENTRY'] },
            simulate: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { integrationMode, simulate = false } = request.body;
      const { sapCookieHeader, sapUser, companyDb } = request.sapSession!;
      const requestMeta = getRequestMeta(request);
      const executionPolicy = resolveSapExecutionPolicy({ simulate });

      // ── 1. Charger la facture complète ──────────────────────────────────────
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { files: true, lines: { orderBy: { lineNo: 'asc' } } },
      });

      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      // ── 2. Garde-fous métier ────────────────────────────────────────────────
      if (invoice.sapDocEntry !== null) {
        return reply.code(409).send({
          success: false,
          error: `Facture déjà intégrée dans SAP B1 (DocEntry: ${invoice.sapDocEntry})`,
        });
      }

      // ── 2. Charger settings + cache TVA SAP puis valider contre SAP ──────
      // Les comptes TVA déductible sont la propriété de SAP (champ TaxAccount
      // d'OVTG, exposé sur /VatGroups), synchronisés dans VatGroupCache. On les
      // récupère ici par code TVA (uniquement codes actifs en catégorie achats).
      const [taxMapSetting, vatCacheRows] = await Promise.all([
        prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } }),
        prisma.vatGroupCache.findMany({
          where: { active: true, category: 'bovcInputTax' },
          select: { code: true, taxAccount: true },
        }),
      ]);
      const taxRateMap = (taxMapSetting?.value ?? {}) as Record<string, string>;
      const vatAccountByCode: Record<string, string | null> = Object.fromEntries(
        vatCacheRows.map((r) => [r.code, r.taxAccount]),
      );
      let attachmentWarning: string | null = null;

      const validationReport = await validateInvoiceForSapPost(
        invoice,
        integrationMode,
        sapCookieHeader,
        taxRateMap,
      );

      await createAuditLogBestEffort({
        action: 'POST_SAP',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: validationReport.ok ? 'OK' : 'ERROR',
        errorMessage: validationReport.ok ? null : buildValidationErrorMessage(validationReport),
        payloadBefore: {
          status: invoice.status,
          integrationMode: invoice.integrationMode,
        },
        payloadAfter: {
          stage: validationReport.ok ? 'SAP_VALIDATION_OK' : 'SAP_VALIDATION_ERROR',
          integrationMode,
          companyDb,
          policy: executionPolicy,
          validationReport,
        },
        ...requestMeta,
      });

      // Les codes TVA invalides sont non-bloquants : on retire le code du payload
      // Codes TVA et centres de coût invalides : non-bloquants (neutralisés dans le payload).
      // Les autres erreurs (supplier, compte comptable, statut) restent bloquantes.
      let effectiveReport = validationReport;
      let hardErrors = effectiveReport.issues.filter(
        (i) => i.code !== 'INVALID_TAX_CODE' && i.code !== 'INVALID_COST_CENTER',
      );

      // Auto-réparation FederalTaxID : si le seul (ou un des) blocage est l'absence
      // de TVA intracom sur le BP SAP et que la facture en contient un, on patche
      // la fiche BP automatiquement puis on rejoue la validation.
      const missingVatIssue = hardErrors.find((i) => i.code === 'MISSING_VAT_IDENTIFIER');
      const supplierExtracted = invoice.supplierExtracted as {
        siret?: string | null;
        vatNumber?: string | null;
        endpointId?: string | null;
      } | null;
      const autoVatNumber = supplierExtracted?.vatNumber?.trim() || null;
      const autoSiret = supplierExtracted?.siret?.trim() || null;
      const autoRoutageCode = supplierExtracted?.endpointId?.trim() || null;

      if (missingVatIssue && autoVatNumber && invoice.supplierB1Cardcode) {
        try {
          // Puisqu'on patche déjà la fiche BP pour résoudre la TVA, on pousse
          // dans la même opération SIRET (LicTradNum) et code de routage PA
          // s'ils sont disponibles — évite un aller-retour supplémentaire.
          await patchBusinessPartnerFiscal(sapCookieHeader, invoice.supplierB1Cardcode, {
            federalTaxId: autoVatNumber,
            ...(autoSiret ? { licTradNum: autoSiret } : {}),
            ...(autoRoutageCode ? { routageCode: autoRoutageCode } : {}),
          });

          // Synchroniser le cache local pour que le matching fournisseur futur
          // bénéficie immédiatement de la TVA (sinon il faut relancer une sync
          // complète SAP pour voir le changement côté validation/matching).
          await prisma.supplierCache
            .update({
              where: { cardcode: invoice.supplierB1Cardcode },
              data: {
                federaltaxid: autoVatNumber,
                ...(autoSiret ? { taxId0: autoSiret } : {}),
                ...(autoRoutageCode ? { pa_identifier: autoRoutageCode } : {}),
                syncAt: new Date(),
              },
            })
            .catch(() => {});

          await createAuditLogBestEffort({
            action: 'EDIT_MAPPING',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'OK',
            payloadAfter: {
              stage: 'AUTO_PUSH_SUPPLIER_FISCAL_OK',
              cardCode: invoice.supplierB1Cardcode,
              federalTaxId: autoVatNumber,
              licTradNum: autoSiret,
              routageCode: autoRoutageCode,
            },
            ...requestMeta,
          });

          // Re-valider après le patch
          effectiveReport = await validateInvoiceForSapPost(
            invoice,
            integrationMode,
            sapCookieHeader,
            taxRateMap,
          );
          hardErrors = effectiveReport.issues.filter(
            (i) => i.code !== 'INVALID_TAX_CODE' && i.code !== 'INVALID_COST_CENTER',
          );
        } catch (patchErr) {
          // L'auto-patch a échoué : on retombe sur le 422 normal avec l'erreur d'origine.
          const patchMessage =
            patchErr instanceof SapSlError
              ? patchErr.sapDetail
              : patchErr instanceof Error
                ? patchErr.message
                : String(patchErr);

          await createAuditLogBestEffort({
            action: 'EDIT_MAPPING',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: patchMessage,
            payloadAfter: {
              stage: 'AUTO_PUSH_SUPPLIER_FISCAL_ERROR',
              cardCode: invoice.supplierB1Cardcode,
            },
            ...requestMeta,
          });
        }
      }

      const invalidTaxCodes = new Set(
        effectiveReport.issues
          .filter((i) => i.code === 'INVALID_TAX_CODE' && i.value)
          .map((i) => i.value as string),
      );
      const invalidCostCenters = new Set(
        effectiveReport.issues
          .filter((i) => i.code === 'INVALID_COST_CENTER' && i.value)
          .map((i) => i.value as string),
      );

      if (hardErrors.length > 0) {
        return reply.code(422).send({
          success: false,
          error: buildValidationErrorMessage({ issues: hardErrors }),
          data: {
            validationReport: effectiveReport,
            policy: executionPolicy,
          },
        });
      }

      // Neutralisation des codes TVA et centres de coût introuvables dans SAP
      const cleanedLines = invoice.lines.map((l) => ({
        ...l,
        chosenTaxCodeB1:
          l.chosenTaxCodeB1 && invalidTaxCodes.has(l.chosenTaxCodeB1) ? null : l.chosenTaxCodeB1,
        suggestedTaxCodeB1:
          l.suggestedTaxCodeB1 && invalidTaxCodes.has(l.suggestedTaxCodeB1)
            ? null
            : l.suggestedTaxCodeB1,
        chosenCostCenter:
          l.chosenCostCenter && invalidCostCenters.has(l.chosenCostCenter)
            ? null
            : l.chosenCostCenter,
        suggestedCostCenter:
          l.suggestedCostCenter && invalidCostCenters.has(l.suggestedCostCenter)
            ? null
            : l.suggestedCostCenter,
      }));

      const warnings: string[] = [];
      if (invalidTaxCodes.size > 0) {
        warnings.push(`Code(s) TVA ignoré(s) : ${[...invalidTaxCodes].join(', ')}`);
        app.log.warn(
          { invoiceId: id, invalidTaxCodes: [...invalidTaxCodes] },
          'Codes TVA invalides ignorés',
        );
      }
      if (invalidCostCenters.size > 0) {
        warnings.push(`Centre(s) de coût ignoré(s) : ${[...invalidCostCenters].join(', ')}`);
        app.log.warn(
          { invoiceId: id, invalidCostCenters: [...invalidCostCenters] },
          'Centres de coût invalides ignorés',
        );
      }
      if (warnings.length > 0) {
        attachmentWarning = warnings.join(' | ');
      }

      if (executionPolicy.effectivePostPolicy === 'disabled') {
        await createAuditLogBestEffort({
          action: 'POST_SAP',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: "Intégration SAP désactivée par la politique d'environnement",
          payloadBefore: {
            status: invoice.status,
            integrationMode: invoice.integrationMode,
          },
          payloadAfter: {
            stage: 'SAP_POST_DISABLED_BY_POLICY',
            integrationMode,
            companyDb,
            policy: executionPolicy,
            validationReport: effectiveReport,
          },
          ...requestMeta,
        });

        return reply.code(409).send({
          success: false,
          error: "Intégration SAP désactivée par la politique d'environnement.",
          data: {
            validationReport,
            policy: executionPolicy,
          },
        });
      }

      // ── 3. Fichier à uploader (premier fichier de la facture) ───────────────
      const fileToUpload = invoice.files[0];

      // ── 4. Simulation ou appel réel ─────────────────────────────────────────
      let sapAttachmentEntry = 0;
      let sapDocEntry: number;
      let sapDocNum: number;

      try {
        if (executionPolicy.effectivePostPolicy === 'simulate') {
          await createAuditLogBestEffort({
            action: 'POST_SAP',
            entityType: 'ATTACHMENT',
            entityId: fileToUpload.id,
            sapUser,
            outcome: 'OK',
            payloadAfter: {
              stage: 'ATTACHMENT_SKIPPED_SIMULATE',
              invoiceId: id,
              filePath: fileToUpload.path,
              policy: executionPolicy,
            },
            ...requestMeta,
          });

          sapAttachmentEntry = 9990 + Math.floor(Math.random() * 9);
          sapDocEntry = 99900 + Math.floor(Math.random() * 99);
          sapDocNum = sapDocEntry;
        } else {
          if (executionPolicy.attachmentPolicy === 'skip') {
            attachmentWarning = "Upload pièce jointe SAP ignoré par la politique d'environnement.";

            await createAuditLogBestEffort({
              action: 'POST_SAP',
              entityType: 'ATTACHMENT',
              entityId: fileToUpload.id,
              sapUser,
              outcome: 'OK',
              payloadAfter: {
                stage: 'ATTACHMENT_POLICY_BYPASS',
                invoiceId: id,
                filePath: fileToUpload.path,
                policy: executionPolicy,
                bypassReason: 'SAP_ATTACHMENT_POLICY=skip',
              },
              ...requestMeta,
            });
          } else {
            try {
              sapAttachmentEntry = await uploadAttachment(sapCookieHeader, fileToUpload.path);

              await createAuditLogBestEffort({
                action: 'POST_SAP',
                entityType: 'ATTACHMENT',
                entityId: fileToUpload.id,
                sapUser,
                outcome: 'OK',
                payloadAfter: {
                  stage: 'ATTACHMENT_UPLOAD_OK',
                  invoiceId: id,
                  filePath: fileToUpload.path,
                  sapAttachmentEntry,
                  policy: executionPolicy,
                },
                ...requestMeta,
              });
            } catch (uploadErr) {
              const msg =
                uploadErr instanceof SapSlError
                  ? uploadErr.sapDetail
                  : uploadErr instanceof Error
                    ? uploadErr.message
                    : String(uploadErr);

              await createAuditLogBestEffort({
                action: 'POST_SAP',
                entityType: 'ATTACHMENT',
                entityId: fileToUpload.id,
                sapUser,
                outcome: 'ERROR',
                errorMessage: msg,
                payloadAfter: {
                  stage:
                    executionPolicy.attachmentPolicy === 'strict'
                      ? 'ATTACHMENT_UPLOAD_ERROR'
                      : 'ATTACHMENT_UPLOAD_WARNING',
                  invoiceId: id,
                  filePath: fileToUpload.path,
                  policy: executionPolicy,
                },
                ...requestMeta,
              });

              if (executionPolicy.attachmentPolicy === 'strict') {
                throw new SapSlError(`Échec upload pièce jointe : ${msg}`, 0, 422);
              }

              app.log.warn(
                { invoiceId: id, error: msg },
                'Upload pièce jointe échoué — poursuite autorisée par la politique',
              );
              attachmentWarning = `Pièce jointe non uploadée dans SAP : ${msg}`;
            }
          }

          // ── 4b. Construction du payload ───────────────────────────────────
          const invoiceData = {
            docNumberPa: invoice.docNumberPa,
            paSource: invoice.paSource,
            paMessageId: invoice.paMessageId,
            direction: invoice.direction,
            supplierB1Cardcode: invoice.supplierB1Cardcode!,
            docDate: invoice.docDate,
            dueDate: invoice.dueDate,
            currency: invoice.currency,
            supplierNameRaw: invoice.supplierNameRaw,
            comment: invoice.comment,
          };

          if (integrationMode === 'SERVICE_INVOICE') {
            const docType =
              invoice.direction === 'CREDIT_NOTE' ? 'PurchaseCreditNotes' : 'PurchaseInvoices';

            const { payload, skippedLines } = buildPurchaseDocPayload(
              invoiceData,
              cleanedLines,
              sapAttachmentEntry,
              taxRateMap,
            );
            if (skippedLines.length > 0) {
              throw new SapSlError(
                `Validation incohérente: lignes sans compte comptable (${skippedLines.join(', ')})`,
                0,
                422,
              );
            }

            const result = await createPurchaseDoc(sapCookieHeader, docType, payload);
            sapDocEntry = result.docEntry;
            sapDocNum = result.docNum;
          } else {
            const { payload, skippedLines, balanceWarning } = buildJournalEntryPayload(
              invoiceData,
              cleanedLines,
              sapAttachmentEntry,
              taxRateMap,
              vatAccountByCode,
            );
            if (skippedLines.length > 0) {
              throw new SapSlError(
                `Validation incohérente: lignes sans compte comptable (${skippedLines.join(', ')})`,
                0,
                422,
              );
            }

            const result = await createJournalEntry(sapCookieHeader, payload);
            sapDocEntry = result.docEntry;
            sapDocNum = result.docNum;

            if (balanceWarning) {
              attachmentWarning = attachmentWarning
                ? `${attachmentWarning} | ${balanceWarning}`
                : balanceWarning;
            }
          }
        }
      } catch (err) {
        const isSapErr = err instanceof SapSlError;
        const message = isSapErr ? err.sapDetail : err instanceof Error ? err.message : String(err);
        const httpCode = isSapErr ? err.httpStatus : 502;
        const sapCode = isSapErr ? err.sapCode : 0;

        // Stocker l'erreur en DB (status ERROR, statusReason = message SAP)
        await prisma.invoice
          .update({
            where: { id },
            data: { status: 'ERROR', statusReason: message },
          })
          .catch(() => {});

        await createAuditLogBestEffort({
          action: 'APPROVE',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadBefore: {
            status: invoice.status,
            integrationMode: invoice.integrationMode,
          },
          payloadAfter: {
            attemptedStatus: 'POSTED',
            integrationMode,
            companyDb,
            simulate: executionPolicy.effectivePostPolicy === 'simulate',
            policy: executionPolicy,
            validationReport: effectiveReport,
          },
          ...requestMeta,
        });

        await createAuditLogBestEffort({
          action: 'POST_SAP',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadBefore: {
            status: invoice.status,
            integrationMode: invoice.integrationMode,
          },
          payloadAfter: {
            stage: 'SAP_POST_ERROR',
            integrationMode,
            sapCode,
            companyDb,
            simulate: executionPolicy.effectivePostPolicy === 'simulate',
            policy: executionPolicy,
            validationReport: effectiveReport,
          },
          ...requestMeta,
        });

        return reply.code(httpCode).send({
          success: false,
          error: message,
          sapCode,
          data: {
            validationReport: effectiveReport,
            policy: executionPolicy,
          },
        });
      }

      // ── 5. Persistance en DB ─────────────────────────────────────────────────
      await prisma.invoice.update({
        where: { id },
        data: {
          status: 'POSTED',
          statusReason: attachmentWarning,
          integrationMode,
          sapDocEntry,
          sapDocNum,
          sapAttachmentEntry: sapAttachmentEntry > 0 ? sapAttachmentEntry : null,
          sapAttachmentUploadedAt: sapAttachmentEntry > 0 ? new Date() : null,
        },
      });

      // Mise à jour du fichier uploadé avec l'AbsoluteEntry
      await prisma.invoiceFile
        .update({
          where: { id: fileToUpload.id },
          data: {}, // AbsoluteEntry n'est pas sur InvoiceFile dans le schéma actuel
        })
        .catch(() => {});

      // ── A3 — Boucle d'apprentissage (best-effort, ne bloque pas la réponse) ──
      applyLearningAfterPost({
        supplierB1Cardcode: invoice.supplierB1Cardcode,
        lines: cleanedLines,
        sapUser,
      }).catch((err) => app.log.warn({ err, invoiceId: id }, 'applyLearningAfterPost failed'));

      // ── 6. Audit ─────────────────────────────────────────────────────────────
      const approvalPayloadAfter = {
        stage:
          executionPolicy.effectivePostPolicy === 'simulate' ? 'SAP_POST_SIMULATED' : 'SAP_POST_OK',
        status: 'POSTED',
        integrationMode,
        sapDocEntry,
        sapDocNum,
        sapAttachmentEntry: sapAttachmentEntry > 0 ? sapAttachmentEntry : null,
        attachmentWarning,
        companyDb,
        simulate: executionPolicy.effectivePostPolicy === 'simulate',
        policy: executionPolicy,
        validationReport: effectiveReport,
      };

      await createAuditLogBestEffort({
        action: 'APPROVE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: {
          status: invoice.status,
          integrationMode: invoice.integrationMode,
        },
        payloadAfter: approvalPayloadAfter,
        ...requestMeta,
      });

      await createAuditLogBestEffort({
        action: 'POST_SAP',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: {
          status: invoice.status,
          integrationMode: invoice.integrationMode,
        },
        payloadAfter: approvalPayloadAfter,
        ...requestMeta,
      });

      return reply.send({
        success: true,
        data: {
          sapDocEntry,
          sapDocNum,
          sapAttachmentEntry: sapAttachmentEntry > 0 ? sapAttachmentEntry : null,
          integrationMode,
          simulate: executionPolicy.effectivePostPolicy === 'simulate',
          status: 'POSTED',
          attachmentWarning,
          validationReport: effectiveReport,
          policy: executionPolicy,
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/link-sap                                  (Voie B)
  // Rattache une facture PA à une facture SAP B1 créée manuellement.
  //
  // Comportement :
  //   - Si body.docNum est fourni → recherche directe par DocNum
  //     (valide ensuite que le CardCode correspond au fournisseur attendu)
  //   - Sinon → recherche via NumAtCard = docNumberPa
  //     • 0 candidat  → 404
  //     • N candidats → 409 avec liste des candidats
  //     • 1 candidat  → rattachement
  //   Dans les deux cas : upload PJ + PATCH + statut LINKED + audit LINK_SAP
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { docNum?: number } }>(
    '/api/invoices/:id/link-sap',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            docNum: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const manualDocNum = request.body?.docNum;
      const { sapCookieHeader, sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

      // ── 1. Charger la facture avec ses fichiers ────────────────────────────
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { files: true },
      });

      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      // ── 2. Garde-fous métier ──────────────────────────────────────────────
      const nonLinkableStatuses = new Set(['POSTED', 'LINKED', 'REJECTED']);
      if (nonLinkableStatuses.has(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Impossible de rattacher une facture au statut "${invoice.status}". Statuts acceptés : NEW, TO_REVIEW, READY, ERROR.`,
        });
      }

      // ── 3. Recherche SAP — par DocNum (manuel) ou par NumAtCard (auto) ────
      let sapInvoice: SapPurchaseInvoiceRef;

      if (manualDocNum !== undefined) {
        let found: SapPurchaseInvoiceRef | null;
        try {
          found = await findPurchaseInvoiceByDocNum(sapCookieHeader, manualDocNum);
        } catch (err) {
          const message =
            err instanceof SapSlError
              ? err.sapDetail
              : err instanceof Error
                ? err.message
                : String(err);
          await createAuditLogBestEffort({
            action: 'LINK_SAP',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: message,
            payloadBefore: { status: invoice.status },
            payloadAfter: { stage: 'SAP_SEARCH_ERROR', docNum: manualDocNum },
            ...requestMeta,
          });
          return reply.code(502).send({ success: false, error: message });
        }

        if (!found) {
          return reply.code(404).send({
            success: false,
            error: `Aucune facture SAP trouvée avec le DocNum ${manualDocNum}.`,
          });
        }

        if (invoice.supplierB1Cardcode && found.cardCode !== invoice.supplierB1Cardcode) {
          return reply.code(422).send({
            success: false,
            error: `La facture SAP DocNum ${manualDocNum} appartient au fournisseur ${found.cardCode} (attendu : ${invoice.supplierB1Cardcode}).`,
          });
        }

        sapInvoice = found;
      } else {
        let searchResult: Awaited<ReturnType<typeof findPurchaseInvoiceByNumAtCard>>;
        try {
          searchResult = await findPurchaseInvoiceByNumAtCard(
            sapCookieHeader,
            invoice.docNumberPa,
            invoice.supplierB1Cardcode ?? undefined,
          );
        } catch (err) {
          const message =
            err instanceof SapSlError
              ? err.sapDetail
              : err instanceof Error
                ? err.message
                : String(err);
          await createAuditLogBestEffort({
            action: 'LINK_SAP',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: message,
            payloadBefore: { status: invoice.status },
            payloadAfter: { stage: 'SAP_SEARCH_ERROR', numAtCard: invoice.docNumberPa },
            ...requestMeta,
          });
          return reply.code(502).send({ success: false, error: message });
        }

        if (searchResult.found === 'none') {
          return reply.code(404).send({
            success: false,
            error: `Aucune facture SAP trouvée avec le numéro de référence "${invoice.docNumberPa}". Vérifiez que la facture a bien été saisie dans SAP B1 avec ce numéro dans le champ Vendor Ref / NumAtCard.`,
          });
        }

        if (searchResult.found === 'many') {
          return reply.code(409).send({
            success: false,
            error: `${searchResult.invoices.length} factures SAP correspondent au numéro "${invoice.docNumberPa}". Rattachement automatique impossible — sélection manuelle requise.`,
            data: { candidates: searchResult.invoices satisfies SapPurchaseInvoiceRef[] },
          });
        }

        sapInvoice = searchResult.invoice;
      }

      // ── 4. Upload pièce jointe sur la facture SAP existante ───────────────
      // Priorité : XML > PDF > premier fichier disponible
      const fileToUpload =
        invoice.files.find((f) => f.kind === 'XML') ??
        invoice.files.find((f) => f.kind === 'PDF') ??
        invoice.files[0];

      let sapAttachmentEntry: number | null = null;

      if (fileToUpload) {
        try {
          sapAttachmentEntry = await attachFileToExistingPurchaseInvoice(
            sapCookieHeader,
            sapInvoice.docEntry,
            fileToUpload.path,
            sapInvoice.attachmentEntry,
          );
        } catch (err) {
          const message =
            err instanceof SapSlError
              ? err.sapDetail
              : err instanceof Error
                ? err.message
                : String(err);
          await createAuditLogBestEffort({
            action: 'LINK_SAP',
            entityType: 'INVOICE',
            entityId: id,
            sapUser,
            outcome: 'ERROR',
            errorMessage: message,
            payloadBefore: { status: invoice.status },
            payloadAfter: {
              stage: 'ATTACHMENT_ERROR',
              numAtCard: invoice.docNumberPa,
              sapDocEntry: sapInvoice.docEntry,
              sapDocNum: sapInvoice.docNum,
            },
            ...requestMeta,
          });
          return reply.code(422).send({ success: false, error: message });
        }
      }

      // ── 5. Persistance DB ─────────────────────────────────────────────────
      const now = new Date();
      await prisma.invoice.update({
        where: { id },
        data: {
          status: 'LINKED',
          sapDocEntry: sapInvoice.docEntry,
          sapDocNum: sapInvoice.docNum,
          sapAttachmentEntry,
          sapAttachmentUploadedAt: sapAttachmentEntry !== null ? now : null,
          statusReason:
            manualDocNum !== undefined
              ? `Facture SAP existante rattachée manuellement (DocNum ${sapInvoice.docNum})`
              : 'Facture SAP existante rattachée via NumAtCard',
        },
      });

      // ── 6. Audit ──────────────────────────────────────────────────────────
      await createAuditLog({
        action: 'LINK_SAP',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: invoice.status },
        payloadAfter: {
          status: 'LINKED',
          mode: manualDocNum !== undefined ? 'MANUAL_DOCNUM' : 'AUTO_NUMATCARD',
          numAtCard: invoice.docNumberPa,
          sapDocEntry: sapInvoice.docEntry,
          sapDocNum: sapInvoice.docNum,
          cardCode: sapInvoice.cardCode,
          attachmentEntry: sapAttachmentEntry,
        },
        ...requestMeta,
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // PATCH /api/invoices/:id/supplier
  // Force le CardCode SAP B1 (override du matching automatique).
  // ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: PatchSupplierBody }>(
    '/api/invoices/:id/supplier',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['supplierB1Cardcode'],
          properties: {
            supplierB1Cardcode: { type: ['string', 'null'], maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { supplierB1Cardcode } = request.body;
      const { sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      if (TERMINAL_STATUSES.has(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Modification impossible au statut "${invoice.status}".`,
        });
      }

      await prisma.invoice.update({
        where: { id },
        data: {
          supplierB1Cardcode,
          supplierMatchConfidence: supplierB1Cardcode ? 100 : 0,
          supplierMatchReason: supplierB1Cardcode ? 'Sélection manuelle utilisateur' : null,
        },
      });

      await recalculateInvoiceStatus(id);

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { supplierB1Cardcode: invoice.supplierB1Cardcode },
        payloadAfter: { supplierB1Cardcode },
        ...getRequestMeta(request),
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // PATCH /api/invoices/:id/comment
  // Met à jour le commentaire libre. Verrouillé après intégration SAP.
  // Remonté dans Comments (PurchaseInvoice) / Memo (JournalEntry) au post.
  // ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: PatchCommentBody }>(
    '/api/invoices/:id/comment',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['comment'],
          properties: {
            comment: { type: ['string', 'null'], maxLength: COMMENT_MAX_LENGTH },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      if (invoice.sapDocEntry !== null) {
        return reply.code(409).send({
          success: false,
          error: `Commentaire verrouillé : facture déjà intégrée dans SAP B1 (DocEntry: ${invoice.sapDocEntry}).`,
        });
      }

      const raw = request.body.comment;
      const next = typeof raw === 'string' ? raw.trim() : null;
      const normalized = next && next.length > 0 ? next : null;

      await prisma.invoice.update({
        where: { id },
        data: { comment: normalized },
      });

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { comment: invoice.comment },
        payloadAfter: { comment: normalized },
        ...getRequestMeta(request),
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // PATCH /api/invoices/:id/lines/:lineId
  // Corrige les champs comptables d'une ligne (compte, centre de coût, code TVA).
  // ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string; lineId: string }; Body: PatchLineBody }>(
    '/api/invoices/:id/lines/:lineId',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'lineId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            lineId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            chosenAccountCode: { type: ['string', 'null'], maxLength: 20 },
            chosenCostCenter: { type: ['string', 'null'], maxLength: 20 },
            chosenTaxCodeB1: { type: ['string', 'null'], maxLength: 20 },
            taxCodeLockedByUser: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, lineId } = request.params;
      const { sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { lines: { where: { id: lineId } } },
      });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      if (TERMINAL_STATUSES.has(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Modification impossible au statut "${invoice.status}".`,
        });
      }
      const line = invoice.lines[0];
      if (!line) return reply.code(404).send({ success: false, error: 'Ligne introuvable' });

      const {
        chosenAccountCode,
        chosenCostCenter,
        chosenTaxCodeB1,
        taxCodeLockedByUser,
        accountCodeLockedByUser,
      } = request.body;
      if (chosenAccountCode !== undefined && chosenAccountCode !== null) {
        const cacheReady = await isCachePopulated();
        if (cacheReady) {
          const accountValidation = await validateCachedAccount(chosenAccountCode);
          if (!accountValidation.ok) {
            // Cache incomplet ? Vérifie directement dans SAP avant de rejeter.
            const { sapCookieHeader } = request.sapSession!;
            let confirmedInSap = false;
            try {
              const live = await searchChartOfAccounts(sapCookieHeader, chosenAccountCode);
              confirmedInSap = live.some(
                (a) => a.acctCode === chosenAccountCode && a.activeAccount,
              );
            } catch {
              /* SAP injoignable — on refuse */
            }

            if (!confirmedInSap) {
              return reply.code(422).send({
                success: false,
                error: `La ligne ${line.lineNo} utilise le compte ${chosenAccountCode}, qui n'existe pas ou n'est pas imputable dans SAP B1.`,
                code: 'INVALID_SAP_ACCOUNT',
              });
            }
          }
        }
      }

      // Quand l'utilisateur définit explicitement un compte, on verrouille automatiquement
      // pour éviter que le ré-enrichissement automatique l'écrase.
      const lockAccount =
        accountCodeLockedByUser !== undefined
          ? accountCodeLockedByUser
          : chosenAccountCode !== undefined && chosenAccountCode !== null
            ? true
            : chosenAccountCode === null
              ? false
              : undefined;

      await prisma.invoiceLine.update({
        where: { id: lineId },
        data: {
          ...(chosenAccountCode !== undefined ? { chosenAccountCode } : {}),
          ...(chosenCostCenter !== undefined ? { chosenCostCenter } : {}),
          ...(chosenTaxCodeB1 !== undefined ? { chosenTaxCodeB1 } : {}),
          ...(taxCodeLockedByUser !== undefined ? { taxCodeLockedByUser } : {}),
          ...(lockAccount !== undefined ? { accountCodeLockedByUser: lockAccount } : {}),
        },
      });

      await recalculateInvoiceStatus(id);

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: {
          lineNo: line.lineNo,
          chosenAccountCode: line.chosenAccountCode,
          chosenCostCenter: line.chosenCostCenter,
          chosenTaxCodeB1: line.chosenTaxCodeB1,
          taxCodeLockedByUser: line.taxCodeLockedByUser,
        },
        payloadAfter: {
          lineNo: line.lineNo,
          chosenAccountCode,
          chosenCostCenter,
          chosenTaxCodeB1,
          taxCodeLockedByUser,
        },
        ...getRequestMeta(request),
      });

      // Apprentissage immédiat : crée/renforce une règle fournisseur, puis ré-enrichit
      // les autres lignes non verrouillées de la même facture (best-effort, non bloquant).
      if (chosenAccountCode) {
        learnFromManualChoice({ invoiceId: id, lineId, chosenAccountCode, sapUser })
          .then(() => enrichInvoiceById(id))
          .catch(() => {});
      }

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/lines/:lineId/resolve-tax-code
  // Résout le code TVA SAP B1 optimal pour un compte comptable donné.
  // Utilisé par le front pour pre-remplir le code TVA quand l'utilisateur
  // change le compte comptable, sans déclencher une sauvegarde.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string; lineId: string }; Body: { accountCode: string } }>(
    '/api/invoices/:id/lines/:lineId/resolve-tax-code',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id', 'lineId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            lineId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['accountCode'],
          properties: {
            accountCode: { type: 'string', minLength: 1, maxLength: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, lineId } = request.params;
      const { accountCode } = request.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { lines: { where: { id: lineId }, select: { taxRate: true } } },
      });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      const line = invoice.lines[0];
      if (!line) return reply.code(404).send({ success: false, error: 'Ligne introuvable' });

      const resolution = await resolveTaxCode({
        supplierCardCode: invoice.supplierB1Cardcode,
        accountCode,
        taxRate: line.taxRate ? Number(line.taxRate) : null,
      });

      return reply.send({ success: true, data: resolution });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // PATCH /api/invoices/:id/draft
  // Sauvegarde les préférences d'intégration sans changer le statut (brouillon).
  // ────────────────────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { integrationMode?: string } }>(
    '/api/invoices/:id/draft',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            integrationMode: { type: 'string', enum: ['SERVICE_INVOICE', 'JOURNAL_ENTRY'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { integrationMode } = request.body;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      if (TERMINAL_STATUSES.has(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Modification impossible au statut "${invoice.status}".`,
        });
      }

      await prisma.invoice.update({
        where: { id },
        data: {
          ...(integrationMode !== undefined
            ? {
                integrationMode:
                  integrationMode as import('@pa-sap-bridge/database').IntegrationMode,
              }
            : {}),
        },
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/reset
  // Remet une facture en erreur en READY ou TO_REVIEW pour permettre une nouvelle tentative.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/reset',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });

      if (invoice.status !== 'ERROR') {
        return reply.code(422).send({
          success: false,
          error: `Remise en traitement impossible : statut actuel "${invoice.status}" (seules les factures en Erreur peuvent être remises en traitement).`,
        });
      }

      // Remet les champs SAP à zéro pour permettre une nouvelle intégration
      await prisma.invoice.update({
        where: { id },
        data: {
          status: 'TO_REVIEW',
          statusReason: null,
          sapDocEntry: null,
          sapDocNum: null,
          sapAttachmentEntry: null,
          sapAttachmentUploadedAt: null,
          integrationMode: null,
        },
      });

      // Re-enrichissement complet : matching fournisseur + suggestions de
      // comptes/TVA + promotion des chosen values quand la confiance suffit.
      // Sans ça, recalculateInvoiceStatus voit des chosen values null et bloque
      // la facture en TO_REVIEW alors qu'à l'ingestion les caches SAP n'étaient
      // peut-être pas prêts.
      await enrichInvoiceById(id).catch((err) => {
        app.log.warn({ err, invoiceId: id }, 'enrichInvoiceById failed during reset');
      });
      await recalculateInvoiceStatus(id);

      await createAuditLogBestEffort({
        action: 'APPROVE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: 'ERROR', statusReason: invoice.statusReason },
        payloadAfter: { status: 'reset', note: 'Remise en traitement manuelle' },
        ...getRequestMeta(request),
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/reject
  // Rejette une facture avec un motif obligatoire.
  // Statuts acceptés : NEW, TO_REVIEW, READY
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: RejectInvoiceBody }>(
    '/api/invoices/:id/reject',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const reason = request.body.reason.trim();
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

      if (reason.length === 0) {
        return reply
          .code(422)
          .send({ success: false, error: 'Le motif de rejet est obligatoire.' });
      }

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      const rejectableStatuses = ['NEW', 'TO_REVIEW', 'READY'];
      if (!rejectableStatuses.includes(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Impossible de rejeter une facture au statut "${invoice.status}". Statuts acceptés : NEW, TO_REVIEW, READY.`,
        });
      }

      await prisma.invoice.update({
        where: { id },
        data: { status: 'REJECTED', statusReason: reason },
      });

      await createAuditLog({
        action: 'REJECT',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: invoice.status, reason: invoice.statusReason },
        payloadAfter: { status: 'REJECTED', reason },
        ...requestMeta,
      });

      return reply.send({ success: true, data: { status: 'REJECTED', reason } });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/litige
  // Met une facture en litige (suspension temporaire, motif obligatoire ≥ 10 car.).
  // Statuts acceptés : DISPUTABLE_STATUSES (NEW, TO_REVIEW, READY).
  // Envoie le cycle de vie IN_DISPUTE à la PA.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: LitigeInvoiceBody }>(
    '/api/invoices/:id/litige',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['motif'],
          properties: {
            motif: { type: 'string', minLength: LITIGE_MIN_MOTIF_LENGTH, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const motif = (request.body.motif ?? '').trim();
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

      // Validation serveur (en plus du JSON-schema) : ne pas faire confiance au front.
      const motifError = validateLitigeMotif(motif);
      if (motifError && motifError.kind === 'INVALID_MOTIF') {
        return reply.code(400).send({
          success: false,
          error:
            motifError.reason === 'EMPTY'
              ? 'Le motif du litige est obligatoire.'
              : `Le motif du litige doit faire au moins ${LITIGE_MIN_MOTIF_LENGTH} caractères.`,
        });
      }

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      const statusError = assertLitigeStatusOk(invoice.status);
      if (statusError) {
        return reply.code(409).send({
          success: false,
          error: `Impossible de mettre en litige une facture au statut "${invoice.status}". Statuts acceptés : ${DISPUTABLE_STATUSES.join(', ')}.`,
        });
      }

      const litigeDate = new Date();

      const updated = await prisma.invoice.update({
        where: { id },
        data: {
          status: 'DISPUTED',
          litigeMotif: motif,
          litigeDate,
        },
      });

      await createAuditLog({
        action: 'INVOICE_LITIGE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: invoice.status, litigeMotif: invoice.litigeMotif },
        payloadAfter: { status: 'DISPUTED', motif, litigeDate: litigeDate.toISOString() },
        ...requestMeta,
      });

      // Envoi du cycle de vie IN_DISPUTE à la PA (best-effort : on n'échoue pas
      // la mise en litige si la livraison PA échoue — un retry pourra être déclenché).
      try {
        const sent = await sendPaStatus(updated);
        await createAuditLog({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'OK',
          payloadBefore: { status: 'DISPUTED', trigger: 'INVOICE_LITIGE' },
          payloadAfter: {
            ...sent.payload,
            deliveryMode: sent.deliveryMode,
            target: sent.target,
          } satisfies Prisma.InputJsonObject,
          ...requestMeta,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await createAuditLogBestEffort({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadBefore: { status: 'DISPUTED', trigger: 'INVOICE_LITIGE' },
          payloadAfter: { stage: 'PA_DISPUTE_NOTIFY_ERROR' },
          ...requestMeta,
        });
      }

      const refreshed = await findInvoiceById(id);
      return reply.send({ success: true, data: refreshed });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/lever-litige
  // Lève un litige : la facture repasse en TO_REVIEW.
  // Envoie le cycle de vie RECEIVED à la PA pour signaler la réouverture.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: LeverLitigeInvoiceBody }>(
    '/api/invoices/:id/lever-litige',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            commentaire: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const commentaire = (request.body?.commentaire ?? '').trim();
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      const statusError = assertLiftLitigeStatusOk(invoice.status);
      if (statusError) {
        return reply.code(409).send({
          success: false,
          error: `Impossible de lever un litige sur une facture au statut "${invoice.status}". Seul DISPUTED est accepté.`,
        });
      }

      const updated = await prisma.invoice.update({
        where: { id },
        data: {
          status: 'TO_REVIEW',
          // On conserve litigeMotif et litigeDate pour l'historique : ils restent
          // visibles dans l'audit, mais n'apparaissent plus sur la fiche (front
          // n'affiche le motif que tant que status === DISPUTED).
        },
      });

      await createAuditLog({
        action: 'INVOICE_LITIGE_LEVE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: {
          status: 'DISPUTED',
          litigeMotif: invoice.litigeMotif,
          litigeDate: invoice.litigeDate?.toISOString() ?? null,
        },
        payloadAfter: { status: 'TO_REVIEW', commentaire: commentaire || null },
        ...requestMeta,
      });

      // Envoi RECEIVED à la PA — outcomeOverride car le statut courant TO_REVIEW
      // ne mappe pas naturellement sur RECEIVED.
      try {
        const sent = await sendPaStatus(updated, 'RECEIVED');
        await createAuditLog({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'OK',
          payloadBefore: { status: 'TO_REVIEW', trigger: 'INVOICE_LITIGE_LEVE' },
          payloadAfter: {
            ...sent.payload,
            deliveryMode: sent.deliveryMode,
            target: sent.target,
          } satisfies Prisma.InputJsonObject,
          ...requestMeta,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await createAuditLogBestEffort({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadBefore: { status: 'TO_REVIEW', trigger: 'INVOICE_LITIGE_LEVE' },
          payloadAfter: { stage: 'PA_RECEIVED_NOTIFY_ERROR' },
          ...requestMeta,
        });
      }

      const refreshed = await findInvoiceById(id);
      return reply.send({ success: true, data: refreshed });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/retour-a-reviser
  // Rétrograde une facture READY vers TO_REVIEW (commentaire facultatif).
  // Action métier purement applicative — pas d'écriture SAP, pas de notif PA.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: RetourAReviserInvoiceBody }>(
    '/api/invoices/:id/retour-a-reviser',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            commentaire: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const commentaire = (request.body?.commentaire ?? '').trim();
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      if (invoice.status !== 'READY') {
        return reply.code(409).send({
          success: false,
          error: "La facture n'est pas en statut prete",
        });
      }

      await prisma.invoice.update({
        where: { id },
        data: { status: 'TO_REVIEW' },
      });

      await createAuditLog({
        action: 'INVOICE_RETOUR_A_REVISER',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: 'READY' },
        payloadAfter: { status: 'TO_REVIEW', commentaire: commentaire || null },
        ...requestMeta,
      });

      const refreshed = await findInvoiceById(id);
      return reply.send({ success: true, data: refreshed });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoices/:id/send-status
  // Envoie le statut de la facture vers la PA.
  // Statuts valides : POSTED (→ VALIDATED) ou REJECTED (→ REJECTED)
  // Idempotent : rejette si paStatusSentAt est déjà renseigné.
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/send-status',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;
      const requestMeta = getRequestMeta(request);
      const retryPolicy = getPaStatusRetryPolicy();

      const invoice = await prisma.invoice.findUnique({ where: { id } });
      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }

      // POSTED et LINKED (Voie B) → VALIDATED ; REJECTED → REJECTED
      const sendableStatuses = ['POSTED', 'LINKED', 'REJECTED'];
      if (!sendableStatuses.includes(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Retour de statut impossible depuis le statut "${invoice.status}". Statuts acceptés : POSTED, LINKED, REJECTED.`,
        });
      }

      if (invoice.paStatusSentAt) {
        return reply.code(409).send({
          success: false,
          error: `Statut déjà envoyé à la PA le ${invoice.paStatusSentAt.toISOString()}.`,
        });
      }

      const failedAttempts = await prisma.auditLog.count({
        where: {
          entityId: id,
          action: 'SEND_STATUS_PA',
          outcome: 'ERROR',
        },
      });

      try {
        const sent = await sendPaStatus(invoice);
        const sentAt = new Date();

        await prisma.invoice.update({
          where: { id },
          data: { paStatusSentAt: sentAt },
        });

        await createAuditLog({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'OK',
          payloadBefore: {
            status: invoice.status,
            paStatusSentAt: null,
          },
          payloadAfter: {
            ...sent.payload,
            attempt: failedAttempts + 1,
            maxRetries: retryPolicy.maxRetries,
            deliveryMode: sent.deliveryMode,
            target: sent.target,
          } satisfies Prisma.InputJsonObject,
          ...requestMeta,
        });

        return reply.send({
          success: true,
          data: { paStatusSentAt: sentAt.toISOString(), outcome: sent.payload.outcome },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempt = failedAttempts + 1;
        const nextRetryAt = computeNextRetryAt(attempt, new Date());

        await createAuditLogBestEffort({
          action: 'SEND_STATUS_PA',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadBefore: {
            status: invoice.status,
            paStatusSentAt: null,
          },
          payloadAfter: {
            ...buildPaStatusPayload(invoice),
            attempt,
            maxRetries: retryPolicy.maxRetries,
            retryScheduled: attempt < retryPolicy.maxRetries,
            nextRetryAt: nextRetryAt?.toISOString() ?? null,
          } satisfies Prisma.InputJsonObject,
          ...requestMeta,
        });

        return reply.code(502).send({ success: false, error: message });
      }
    },
  );

  // ── POST /api/invoices/:id/re-enrich ───────────────────────────────────────
  // Re-applique le moteur de matching (fournisseur + suggestions) sur une facture.
  // Statuts autorisés : NEW, TO_REVIEW (les terminaux POSTED/REJECTED/ERROR sont ignorés).
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/re-enrich',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;

      const exists = await prisma.invoice.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!exists) return reply.code(404).send({ success: false, error: 'Facture introuvable' });

      await enrichInvoiceById(id);

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadAfter: { stage: 'RE_ENRICH_OK' },
        ...getRequestMeta(request),
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ── POST /api/invoices/:id/re-parse-lines ──────────────────────────────────
  // Relit le fichier XML source et remplace les lignes en base.
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/re-parse-lines',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      if (['POSTED', 'REJECTED'].includes(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Impossible de ré-analyser une facture au statut ${invoice.status}`,
        });
      }

      // Trouver le fichier XML source
      const xmlFile = await prisma.invoiceFile.findFirst({
        where: { invoiceId: id, kind: 'XML' },
        select: { path: true },
        orderBy: { id: 'asc' },
      });
      if (!xmlFile) {
        return reply.code(422).send({
          success: false,
          error: 'Aucun fichier XML trouvé pour cette facture',
        });
      }
      if (!fs.existsSync(xmlFile.path)) {
        return reply.code(422).send({
          success: false,
          error: `Fichier XML introuvable sur disque : ${path.basename(xmlFile.path)}`,
        });
      }

      // Ré-analyse
      const xmlContent = fs.readFileSync(xmlFile.path, 'utf-8');
      const filename = path
        .basename(xmlFile.path)
        .replace(/^[^-]+-[^-]+-/, '')
        .replace(/\.[^.]+$/, '');
      const parsed = parseInvoiceXml(xmlContent, filename);

      if (parsed.lines.length === 0) {
        return reply.code(422).send({
          success: false,
          error: 'Aucune ligne trouvée dans le fichier XML',
        });
      }

      // Remplace les lignes en base (transaction)
      await prisma.$transaction([
        prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
        prisma.invoiceLine.createMany({
          data: parsed.lines.map((l) => ({
            invoiceId: id,
            lineNo: l.lineNo,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amountExclTax: l.amountExclTax,
            taxCode: l.taxCode,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
            amountInclTax: l.amountInclTax,
          })),
        }),
      ]);

      // Ré-enrichissement immédiat pour résoudre les comptes comptables
      await enrichInvoiceById(id).catch(() => {});

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadAfter: { stage: 'RE_PARSE_LINES_OK', linesCount: parsed.lines.length },
        ...getRequestMeta(request),
      });

      const updated = await findInvoiceById(id);
      return reply.send({ success: true, data: updated });
    },
  );

  // ── POST /api/invoices/:id/push-supplier-fiscal ───────────────────────────
  // Pousse les identifiants fiscaux extraits de la facture (SIRET/SIREN + TVA)
  // vers la fiche BusinessPartner SAP B1 du fournisseur associé.
  // Source : invoice.supplierExtracted.siret | siren | vatNumber
  // Cible  : SAP B1 → TaxId0 (N° identification entreprise) + FederalTaxID (TVA)
  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/push-supplier-fiscal',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapCookieHeader, sapUser } = request.sapSession!;

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          supplierB1Cardcode: true,
          supplierExtracted: true,
        },
      });

      if (!invoice) {
        return reply.code(404).send({ success: false, error: 'Facture introuvable' });
      }
      if (!invoice.supplierB1Cardcode) {
        return reply
          .code(422)
          .send({ success: false, error: 'Aucun fournisseur SAP B1 associé à cette facture.' });
      }

      const extracted = invoice.supplierExtracted as {
        siret?: string | null;
        siren?: string | null;
        vatNumber?: string | null;
        endpointId?: string | null;
      } | null;

      const federalTaxId = extracted?.vatNumber?.trim() || null;
      const licTradNum = extracted?.siret?.trim() || null;
      const routageCode = extracted?.endpointId?.trim() || null;

      if (!federalTaxId && !licTradNum && !routageCode) {
        return reply.code(422).send({
          success: false,
          error:
            'La facture ne contient ni TVA intracommunautaire, ni SIRET, ni code de routage PA à pousser vers SAP B1.',
        });
      }

      try {
        await patchBusinessPartnerFiscal(sapCookieHeader, invoice.supplierB1Cardcode, {
          ...(federalTaxId ? { federalTaxId } : {}),
          ...(licTradNum ? { licTradNum } : {}),
          ...(routageCode ? { routageCode } : {}),
        });
      } catch (err) {
        const message =
          err instanceof SapSlError
            ? err.sapDetail
            : err instanceof Error
              ? err.message
              : String(err);
        const httpCode = err instanceof SapSlError ? err.httpStatus : 502;

        await createAuditLogBestEffort({
          action: 'EDIT_MAPPING',
          entityType: 'INVOICE',
          entityId: id,
          sapUser,
          outcome: 'ERROR',
          errorMessage: message,
          payloadAfter: {
            stage: 'PUSH_SUPPLIER_FISCAL_ERROR',
            cardCode: invoice.supplierB1Cardcode,
          },
          ...getRequestMeta(request),
        });

        return reply.code(httpCode).send({ success: false, error: message });
      }

      // Mise à jour du cache local fournisseurs
      await prisma.supplierCache
        .update({
          where: { cardcode: invoice.supplierB1Cardcode },
          data: {
            ...(federalTaxId ? { federaltaxid: federalTaxId } : {}),
            ...(licTradNum ? { taxId0: licTradNum } : {}),
            ...(routageCode ? { pa_identifier: routageCode } : {}),
            syncAt: new Date(),
          },
        })
        .catch(() => {}); // cache best-effort

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadAfter: {
          stage: 'PUSH_SUPPLIER_FISCAL_OK',
          cardCode: invoice.supplierB1Cardcode,
          federalTaxId,
          licTradNum,
          routageCode,
        },
        ...getRequestMeta(request),
      });

      return reply.send({
        success: true,
        data: {
          cardCode: invoice.supplierB1Cardcode,
          taxId0: licTradNum,
          federalTaxId,
          routageCode,
        },
      });
    },
  );

  // ── POST /api/invoices/re-enrich-all ──────────────────────────────────────
  // Batch : re-applique le matching sur toutes les factures NEW/TO_REVIEW.
  app.post(
    '/api/invoices/re-enrich-all',
    { preHandler: requireSession },
    async (request, reply) => {
      const { sapUser } = request.sapSession!;
      const result = await enrichPendingInvoices();

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'INVOICE',
        entityId: 'BATCH',
        sapUser,
        outcome: 'OK',
        payloadAfter: result,
        ...getRequestMeta(request),
      });

      return reply.send({ success: true, data: result });
    },
  );
}

// ─── Helper : recalcul du statut après correction manuelle ────────────────────

async function recalculateInvoiceStatus(invoiceId: string): Promise<void> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!inv || TERMINAL_STATUSES.has(inv.status)) return;

  const hasSupplier = !!inv.supplierB1Cardcode;
  // Une ligne est utilisable pour l'intégration SAP dès qu'elle a un compte et
  // un code TVA — peu importe qu'ils viennent du choix utilisateur ou de la
  // suggestion (cf. resolveAccountCode/resolveTaxCode dans sap-invoice-builder).
  const allLinesHaveAccount =
    inv.lines.length > 0 &&
    inv.lines.every(
      (l) =>
        (l.chosenAccountCode ?? l.suggestedAccountCode) !== null &&
        (l.chosenTaxCodeB1 ?? l.suggestedTaxCodeB1) !== null,
    );

  const newStatus = hasSupplier && allLinesHaveAccount ? 'READY' : 'TO_REVIEW';

  const parts: string[] = [];
  if (!hasSupplier) parts.push('fournisseur non résolu dans SAP B1');
  if (!allLinesHaveAccount)
    parts.push(
      inv.lines.length === 0
        ? 'aucune ligne structurée'
        : 'compte comptable ou code TVA B1 manquant sur une ou plusieurs lignes',
    );

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: newStatus,
      statusReason:
        newStatus === 'TO_REVIEW' ? parts.join(' ; ') || 'révision manuelle requise' : null,
    },
  });
}
