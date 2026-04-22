import type { FastifyInstance } from 'fastify';
import {
  findInvoices,
  findInvoiceById,
  findInvoiceFiles,
  type FindInvoicesParams,
} from '../repositories/invoice.repository';
import { requireSession } from '../middleware/require-session';
import { uploadAttachment, createPurchaseDoc, createJournalEntry, SapSlError } from '../services/sap-sl.service';
import { buildPurchaseDocPayload, buildJournalEntryPayload } from '../services/sap-invoice-builder';
import { sendPaStatus } from '../services/pa-status.service';
import {
  buildPaStatusPayload,
  computeNextRetryAt,
  createAuditLog,
  createAuditLogBestEffort,
  getPaStatusRetryPolicy,
  prisma,
} from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';

const INVOICE_STATUSES = ['NEW', 'TO_REVIEW', 'READY', 'POSTED', 'REJECTED', 'ERROR'] as const;
const SORT_FIELDS = ['receivedAt', 'docDate', 'totalInclTax', 'status', 'supplierNameRaw'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TERMINAL_STATUSES = new Set(['POSTED', 'REJECTED', 'ERROR']);

interface PostInvoiceBody {
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  simulate?: boolean;
}

interface PatchSupplierBody {
  supplierB1Cardcode: string | null;
}

interface PatchLineBody {
  chosenAccountCode?: string | null;
  chosenCostCenter?: string | null;
  chosenTaxCodeB1?: string | null;
}

interface RejectInvoiceBody {
  reason: string;
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
  sortBy?: string;
  sortDir?: string;
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
            page:              { type: 'integer', minimum: 1, default: 1 },
            limit:             { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            status:            { type: 'string', enum: [...INVOICE_STATUSES] },
            paSource:          { type: 'string', maxLength: 100 },
            supplierCardcode:  { type: 'string', maxLength: 50 },
            dateFrom:          { type: 'string', format: 'date' },
            dateTo:            { type: 'string', format: 'date' },
            search:            { type: 'string', maxLength: 100 },
            sortBy:            { type: 'string', enum: [...SORT_FIELDS] },
            sortDir:           { type: 'string', enum: ['asc', 'desc'] },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const params: FindInvoicesParams = {
        page, limit,
        status: q.status as FindInvoicesParams['status'],
        paSource: q.paSource,
        supplierCardcode: q.supplierCardcode,
        dateFrom: q.dateFrom,
        dateTo: q.dateTo,
        search: q.search,
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
            simulate:        { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { integrationMode, simulate = false } = request.body;
      const { b1Session, sapUser, companyDb } = request.sapSession!;
      const requestMeta = getRequestMeta(request);

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

      const allowedStatuses = ['READY', 'TO_REVIEW'];
      if (!allowedStatuses.includes(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Intégration impossible depuis le statut "${invoice.status}". Statuts acceptés : READY, TO_REVIEW.`,
        });
      }

      if (invoice.files.length === 0) {
        return reply.code(422).send({
          success: false,
          error: 'Aucune pièce jointe associée à cette facture. Upload obligatoire avant intégration.',
        });
      }

      if (integrationMode === 'SERVICE_INVOICE' && !invoice.supplierB1Cardcode) {
        return reply.code(422).send({
          success: false,
          error: 'Fournisseur non résolu dans SAP B1 (CardCode manquant). Résolvez le matching avant d\'intégrer.',
        });
      }

      // ── 3. Charger le TAX_RATE_MAPPING depuis les settings ─────────────────
      const taxMapSetting = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
      const taxRateMap   = (taxMapSetting?.value ?? {}) as Record<string, string>;

      // ── 4. Fichier à uploader (premier fichier de la facture) ───────────────
      const fileToUpload = invoice.files[0];

      // ── 5. Simulation ou appel réel ─────────────────────────────────────────
      let sapAttachmentEntry: number;
      let sapDocEntry: number;
      let sapDocNum: number;
      let attachmentWarning: string | null = null;

      try {
        if (simulate) {
          // Mode simulation : on génère des numéros factices
          sapAttachmentEntry = 9990 + Math.floor(Math.random() * 9);
          sapDocEntry        = 99900 + Math.floor(Math.random() * 99);
          sapDocNum          = sapDocEntry;
        } else {
          // ── 5a. Upload pièce jointe — best-effort, non bloquant ───────────
          try {
            sapAttachmentEntry = await uploadAttachment(b1Session, fileToUpload.path);
          } catch (uploadErr) {
            const msg = uploadErr instanceof SapSlError
              ? uploadErr.sapDetail
              : (uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
            app.log.warn({ invoiceId: id, error: msg }, 'Upload pièce jointe échoué — intégration continue sans pièce jointe');
            sapAttachmentEntry = 0;
            attachmentWarning  = `Pièce jointe non uploadée dans SAP : ${msg}`;
          }

          // ── 5b. Construction du payload ───────────────────────────────────
          const invoiceData = {
            docNumberPa:        invoice.docNumberPa,
            direction:          invoice.direction,
            supplierB1Cardcode: invoice.supplierB1Cardcode!,
            docDate:            invoice.docDate,
            dueDate:            invoice.dueDate,
            currency:           invoice.currency,
            supplierNameRaw:    invoice.supplierNameRaw,
          };

          if (integrationMode === 'SERVICE_INVOICE') {
            const docType = invoice.direction === 'CREDIT_NOTE'
              ? 'PurchaseCreditNotes'
              : 'PurchaseInvoices';

            const { payload, skippedLines } = buildPurchaseDocPayload(
              invoiceData, invoice.lines, sapAttachmentEntry, taxRateMap,
            );
            if (skippedLines.length > 0) {
              app.log.warn({ skippedLines, invoiceId: id }, 'Lignes sans compte comptable ignorées');
            }

            const result = await createPurchaseDoc(b1Session, docType, payload);
            sapDocEntry  = result.docEntry;
            sapDocNum    = result.docNum;

          } else {
            const { payload, skippedLines } = buildJournalEntryPayload(
              invoiceData, invoice.lines, sapAttachmentEntry, taxRateMap,
            );
            if (skippedLines.length > 0) {
              app.log.warn({ skippedLines, invoiceId: id }, 'Lignes sans compte comptable ignorées');
            }

            const result = await createJournalEntry(b1Session, payload);
            sapDocEntry  = result.docEntry;
            sapDocNum    = result.docNum;
          }
        }
      } catch (err) {
        const isSapErr  = err instanceof SapSlError;
        const message   = isSapErr ? err.sapDetail : (err instanceof Error ? err.message : String(err));
        const httpCode  = isSapErr ? err.httpStatus : 502;
        const sapCode   = isSapErr ? err.sapCode   : 0;

        // Stocker l'erreur en DB (status ERROR, statusReason = message SAP)
        await prisma.invoice.update({
          where: { id },
          data:  { status: 'ERROR', statusReason: message },
        }).catch(() => {});

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
            simulate,
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
          payloadAfter: { integrationMode, sapCode, companyDb, simulate },
          ...requestMeta,
        });

        return reply.code(httpCode).send({
          success:  false,
          error:    message,
          sapCode,
        });
      }

      // ── 6. Persistance en DB ─────────────────────────────────────────────────
      await prisma.invoice.update({
        where: { id },
        data: {
          status:              'POSTED',
          statusReason:        attachmentWarning,
          integrationMode,
          sapDocEntry,
          sapDocNum,
          sapAttachmentEntry:      sapAttachmentEntry > 0 ? sapAttachmentEntry : null,
          sapAttachmentUploadedAt: sapAttachmentEntry > 0 ? new Date() : null,
        },
      });

      // Mise à jour du fichier uploadé avec l'AbsoluteEntry
      await prisma.invoiceFile.update({
        where: { id: fileToUpload.id },
        data:  {},   // AbsoluteEntry n'est pas sur InvoiceFile dans le schéma actuel
      }).catch(() => {});

      // ── 7. Audit ─────────────────────────────────────────────────────────────
      const approvalPayloadAfter = {
        status: 'POSTED',
        integrationMode,
        sapDocEntry,
        sapDocNum,
        sapAttachmentEntry: sapAttachmentEntry > 0 ? sapAttachmentEntry : null,
        attachmentWarning,
        companyDb,
        simulate,
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
          simulate,
          status: 'POSTED',
          attachmentWarning,
        },
      });
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
        return reply.code(422).send({ success: false, error: `Modification impossible au statut "${invoice.status}".` });
      }

      await prisma.invoice.update({
        where: { id },
        data: {
          supplierB1Cardcode,
          supplierMatchConfidence: supplierB1Cardcode ? 100 : 0,
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
            id:     { type: 'string', format: 'uuid' },
            lineId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            chosenAccountCode: { type: ['string', 'null'], maxLength: 20 },
            chosenCostCenter:  { type: ['string', 'null'], maxLength: 20 },
            chosenTaxCodeB1:   { type: ['string', 'null'], maxLength: 20 },
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
        return reply.code(422).send({ success: false, error: `Modification impossible au statut "${invoice.status}".` });
      }
      const line = invoice.lines[0];
      if (!line) return reply.code(404).send({ success: false, error: 'Ligne introuvable' });

      const { chosenAccountCode, chosenCostCenter, chosenTaxCodeB1 } = request.body;

      await prisma.invoiceLine.update({
        where: { id: lineId },
        data: {
          ...(chosenAccountCode !== undefined ? { chosenAccountCode } : {}),
          ...(chosenCostCenter  !== undefined ? { chosenCostCenter  } : {}),
          ...(chosenTaxCodeB1   !== undefined ? { chosenTaxCodeB1   } : {}),
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
          chosenCostCenter:  line.chosenCostCenter,
          chosenTaxCodeB1:   line.chosenTaxCodeB1,
        },
        payloadAfter: { lineNo: line.lineNo, chosenAccountCode, chosenCostCenter, chosenTaxCodeB1 },
        ...getRequestMeta(request),
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
          status:                  'TO_REVIEW',
          statusReason:            null,
          sapDocEntry:             null,
          sapDocNum:               null,
          sapAttachmentEntry:      null,
          sapAttachmentUploadedAt: null,
          integrationMode:         null,
        },
      });

      // Recalcule READY ou TO_REVIEW selon l'état réel de la facture
      await recalculateInvoiceStatus(id);

      await createAuditLogBestEffort({
        action: 'APPROVE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { status: 'ERROR', statusReason: invoice.statusReason },
        payloadAfter:  { status: 'reset', note: 'Remise en traitement manuelle' },
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
        return reply.code(422).send({ success: false, error: 'Le motif de rejet est obligatoire.' });
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

      const sendableStatuses = ['POSTED', 'REJECTED'];
      if (!sendableStatuses.includes(invoice.status)) {
        return reply.code(422).send({
          success: false,
          error: `Retour de statut impossible depuis le statut "${invoice.status}". Statuts acceptés : POSTED, REJECTED.`,
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
        const sentAt  = new Date();

        await prisma.invoice.update({
          where: { id },
          data:  { paStatusSentAt: sentAt },
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
            targetFile: sent.targetFile,
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
}

// ─── Helper : recalcul du statut après correction manuelle ────────────────────

async function recalculateInvoiceStatus(invoiceId: string): Promise<void> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!inv || TERMINAL_STATUSES.has(inv.status)) return;

  const hasSupplier = !!inv.supplierB1Cardcode;
  const allLinesHaveAccount =
    inv.lines.length > 0 &&
    inv.lines.every((l) => (l.chosenAccountCode ?? l.suggestedAccountCode) !== null);

  const newStatus = hasSupplier && allLinesHaveAccount ? 'READY' : 'TO_REVIEW';

  const parts: string[] = [];
  if (!hasSupplier) parts.push('fournisseur non résolu dans SAP B1');
  if (!allLinesHaveAccount)
    parts.push(inv.lines.length === 0 ? 'aucune ligne structurée' : 'compte comptable manquant sur une ou plusieurs lignes');

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: newStatus,
      statusReason: newStatus === 'TO_REVIEW' ? (parts.join(' ; ') || 'révision manuelle requise') : null,
    },
  });
}
