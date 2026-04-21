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

interface PostInvoiceBody {
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  simulate?: boolean;
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

      // Compte AP pour Journal Entry (configurable via settings ou fallback)
      const apAcctSetting = await prisma.setting.findUnique({ where: { key: 'AP_ACCOUNT_CODE' } });
      const apAccount     = (apAcctSetting?.value as string | undefined) ?? '40100000';

      // ── 4. Fichier à uploader (premier fichier de la facture) ───────────────
      const fileToUpload = invoice.files[0];

      // ── 5. Simulation ou appel réel ─────────────────────────────────────────
      let sapAttachmentEntry: number;
      let sapDocEntry: number;
      let sapDocNum: number;

      try {
        if (simulate) {
          // Mode simulation : on génère des numéros factices
          sapAttachmentEntry = 9990 + Math.floor(Math.random() * 9);
          sapDocEntry        = 99900 + Math.floor(Math.random() * 99);
          sapDocNum          = sapDocEntry;
        } else {
          // ── 5a. Upload obligatoire — bloquant si échoue ───────────────────
          sapAttachmentEntry = await uploadAttachment(b1Session, fileToUpload.path);

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
              invoiceData, invoice.lines, sapAttachmentEntry, taxRateMap, apAccount,
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
          statusReason:        null,
          integrationMode,
          sapDocEntry,
          sapDocNum,
          sapAttachmentEntry,
          sapAttachmentUploadedAt: new Date(),
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
        sapAttachmentEntry,
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
          sapAttachmentEntry,
          integrationMode,
          simulate,
          status: 'POSTED',
        },
      });
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
