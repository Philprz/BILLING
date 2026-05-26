import type { FastifyInstance } from 'fastify';
import { findSuppliers } from '../repositories/supplier.repository';
import { requireSession } from '../middleware/require-session';
import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import { createBusinessPartner, SapSlError } from '../services/sap-sl.service';
import {
  getSuppliersSyncStatus,
  syncSuppliersFromSap,
} from '../services/sap-suppliers-sync.service';

interface CreateSupplierBody {
  cardCode: string;
  cardName: string;
  /** N° TVA intracommunautaire (FR + 11 chiffres). */
  federalTaxId?: string;
  /** SIRET 14 chiffres. */
  licTradNum?: string;
  /** Code de routage PA (Piste d'Audit Fiable) propre au fournisseur. */
  routageCode?: string;
  vatRegNum?: string;
  street?: string;
  street2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  phone?: string;
  invoiceId?: string;
}

const SIRET_RE = /^\d{14}$/;
const FR_VAT_RE = /^FR[0-9A-Z]{2}\d{9}$/;

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
interface SupplierListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/suppliers-cache ────────────────────────────────────────────────
  app.get<{ Querystring: SupplierListQuery }>(
    '/api/suppliers-cache',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            search: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const { items, total } = await findSuppliers({ page, limit, search: q.search });
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        success: true,
        data: { items, total, page, limit, totalPages },
      });
    },
  );

  // ── POST /api/suppliers/sync ───────────────────────────────────────────────
  app.post('/api/suppliers/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader, sapUser } = request.sapSession!;
    const result = await syncSuppliersFromSap(sapCookieHeader, sapUser);
    if (result.errors.length > 0 && result.total === 0) {
      return reply
        .code(502)
        .send({ success: false, error: result.errors[0].message, data: result });
    }
    return reply.send({ success: true, data: result });
  });

  // Compatibilité avec l'ancien front.
  app.post('/api/suppliers-cache/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader, sapUser } = request.sapSession!;
    const result = await syncSuppliersFromSap(sapCookieHeader, sapUser);
    return reply.send({
      success: result.errors.length === 0,
      data: { ...result, upserted: result.inserted + result.updated },
      error: result.errors[0]?.message,
    });
  });

  app.get('/api/suppliers/sync/status', { preHandler: requireSession }, async (_request, reply) => {
    return reply.send({ success: true, data: await getSuppliersSyncStatus() });
  });

  app.get<{ Querystring: { q?: string; limit?: number } }>(
    '/api/suppliers/search',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query.q?.trim();
      const limit = Math.min(request.query.limit ?? 20, 50);
      const { items, total } = await findSuppliers({ page: 1, limit, search: q });
      return reply.send({ success: true, data: { items, total } });
    },
  );

  // ── POST /api/suppliers/create-in-sap ──────────────────────────────────────
  // Crée un fournisseur dans SAP B1 et l'ajoute au cache local.
  app.post<{ Body: CreateSupplierBody }>(
    '/api/suppliers/create-in-sap',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['cardCode', 'cardName'],
          properties: {
            cardCode: { type: 'string', minLength: 1, maxLength: 15 },
            cardName: { type: 'string', minLength: 1, maxLength: 100 },
            federalTaxId: { type: 'string', maxLength: 32 },
            licTradNum: { type: 'string', maxLength: 32 },
            routageCode: { type: 'string', maxLength: 50 },
            vatRegNum: { type: 'string', maxLength: 32 },
            street: { type: 'string', maxLength: 200 },
            street2: { type: 'string', maxLength: 200 },
            city: { type: 'string', maxLength: 100 },
            postalCode: { type: 'string', maxLength: 20 },
            country: { type: 'string', maxLength: 3 },
            email: { type: 'string', maxLength: 200 },
            phone: { type: 'string', maxLength: 50 },
            invoiceId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        cardCode,
        cardName,
        federalTaxId,
        licTradNum,
        routageCode,
        vatRegNum,
        street,
        street2,
        city,
        postalCode,
        country,
        email,
        phone,
        invoiceId,
      } = request.body;
      const { sapCookieHeader, sapUser } = request.sapSession!;

      // Validation et warnings sur les 3 champs clés. Aucune valeur n'est inventée :
      // si le format est invalide, on n'envoie pas le champ à SAP plutôt que de
      // polluer la fiche fournisseur avec une valeur erronée.
      const cleanLicTradNum = licTradNum?.trim() || undefined;
      const cleanFederalTaxId = federalTaxId?.trim() || undefined;
      const cleanRoutageCode = routageCode?.trim() || undefined;

      let sapLicTradNum: string | undefined;
      if (cleanLicTradNum) {
        if (SIRET_RE.test(cleanLicTradNum)) {
          sapLicTradNum = cleanLicTradNum;
        } else {
          request.log.warn(
            `[BP-CREATE] LicTradNum ignoré pour CardCode ${cardCode} — format SIRET invalide (attendu 14 chiffres) : "${cleanLicTradNum}"`,
          );
        }
      } else {
        request.log.warn(
          `[BP-CREATE] LicTradNum absent pour CardCode ${cardCode} — SIRET non extrait`,
        );
      }

      let sapFederalTaxId: string | undefined;
      if (cleanFederalTaxId) {
        if (FR_VAT_RE.test(cleanFederalTaxId.toUpperCase())) {
          sapFederalTaxId = cleanFederalTaxId.toUpperCase();
        } else {
          request.log.warn(
            `[BP-CREATE] FederalTaxID ignoré pour CardCode ${cardCode} — format TVA intracom invalide (attendu FRxx + 9 chiffres) : "${cleanFederalTaxId}"`,
          );
        }
      } else {
        request.log.warn(
          `[BP-CREATE] FederalTaxID absent pour CardCode ${cardCode} — TVA non extraite`,
        );
      }

      if (!cleanRoutageCode) {
        request.log.warn(`[BP-CREATE] Code de routage PA absent pour CardCode ${cardCode}`);
      }

      try {
        const result = await createBusinessPartner(sapCookieHeader, {
          cardCode,
          cardName,
          federalTaxId: sapFederalTaxId,
          licTradNum: sapLicTradNum,
          routageCode: cleanRoutageCode,
          vatRegNum,
          street,
          street2,
          city,
          postalCode,
          country,
          email,
          phone,
        });

        await prisma.supplierCache.upsert({
          where: { cardcode: result.cardCode },
          create: {
            cardcode: result.cardCode,
            cardname: cardName,
            federaltaxid: sapFederalTaxId ?? null,
            vatregnum: vatRegNum ?? null,
            taxId0: sapLicTradNum ?? null,
            pa_identifier: cleanRoutageCode ?? null,
            cardtype: 'cSupplier',
            validFor: true,
            rawPayload: {
              source: 'create-in-sap',
              cardCode: result.cardCode,
              cardName,
              federalTaxId: sapFederalTaxId ?? null,
              licTradNum: sapLicTradNum ?? null,
              routageCode: cleanRoutageCode ?? null,
              vatRegNum: vatRegNum ?? null,
            },
            lastSyncAt: new Date(),
          },
          update: {
            cardname: cardName,
            federaltaxid: sapFederalTaxId ?? null,
            vatregnum: vatRegNum ?? null,
            taxId0: sapLicTradNum ?? null,
            pa_identifier: cleanRoutageCode ?? null,
            cardtype: 'cSupplier',
            validFor: true,
            syncAt: new Date(),
            lastSyncAt: new Date(),
          },
        });

        await createAuditLogBestEffort({
          action: 'CREATE_SUPPLIER',
          entityType: 'INVOICE',
          entityId: invoiceId ?? null,
          sapUser,
          outcome: 'OK',
          payloadAfter: {
            cardCode: result.cardCode,
            cardName,
            federalTaxId: sapFederalTaxId ?? null,
            licTradNum: sapLicTradNum ?? null,
            routageCode: cleanRoutageCode ?? null,
            vatRegNum: vatRegNum ?? null,
            street: street ?? null,
            street2: street2 ?? null,
            city: city ?? null,
            postalCode: postalCode ?? null,
            country: country ?? null,
            email: email ?? null,
            phone: phone ?? null,
          },
          ...getRequestMeta(request),
        });

        return reply
          .code(201)
          .send({ success: true, data: { cardCode: result.cardCode, cardName } });
      } catch (err) {
        const msg =
          err instanceof SapSlError
            ? err.sapDetail
            : err instanceof Error
              ? err.message
              : String(err);
        const httpStatus = err instanceof SapSlError ? err.httpStatus : 502;

        await createAuditLogBestEffort({
          action: 'CREATE_SUPPLIER',
          entityType: 'INVOICE',
          entityId: invoiceId ?? null,
          sapUser,
          outcome: 'ERROR',
          errorMessage: msg,
          payloadAfter: {
            cardCode,
            cardName,
            federalTaxId: sapFederalTaxId ?? null,
            licTradNum: sapLicTradNum ?? null,
            routageCode: cleanRoutageCode ?? null,
            vatRegNum: vatRegNum ?? null,
          },
          ...getRequestMeta(request),
        });

        return reply.code(httpStatus).send({ success: false, error: msg });
      }
    },
  );
}
