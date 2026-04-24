import type { FastifyInstance } from 'fastify';
import { findSuppliers } from '../repositories/supplier.repository';
import { requireSession } from '../middleware/require-session';
import { prisma } from '@pa-sap-bridge/database';
import { normalizeSapCookieHeader } from '../services/sap-auth.service';
import { createBusinessPartner, SapSlError } from '../services/sap-sl.service';

interface CreateSupplierBody {
  cardCode: string;
  cardName: string;
  federalTaxId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');

interface SupplierListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

interface SapBpRow {
  CardCode: string;
  CardName: string;
  FederalTaxID?: string;
  VATRegistrationNumber?: string;
}

async function fetchSapSuppliers(sapCookie: string): Promise<SapBpRow[]> {
  const cookie = normalizeSapCookieHeader(sapCookie);
  const all: SapBpRow[] = [];
  let skip = 0;
  const top = 100;

  for (;;) {
    const url =
      `${SAP_BASE_URL}/BusinessPartners` +
      `?$select=CardCode,CardName,FederalTaxID,VATRegistrationNumber` +
      `&$filter=CardType eq 'cSupplier' and Frozen eq 'tNO'` +
      `&$top=${top}&$skip=${skip}`;

    const res = await fetch(url, { headers: { Cookie: cookie } });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`SAP BusinessPartners (${res.status}): ${text}`);
    }

    const body = (await res.json()) as { value: SapBpRow[] };
    const rows = body.value ?? [];
    all.push(...rows);
    if (rows.length < top) break;
    skip += top;
  }

  return all;
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

  // ── POST /api/suppliers-cache/sync ─────────────────────────────────────────
  // Pulls BusinessPartners (CardType=cSupplier) from SAP and upserts into local cache.
  app.post('/api/suppliers-cache/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;

    let sapRows: SapBpRow[];
    try {
      sapRows = await fetchSapSuppliers(sapCookieHeader);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply
        .code(502)
        .send({ success: false, error: `Erreur SAP lors de la synchronisation : ${msg}` });
    }

    let upserted = 0;
    for (const row of sapRows) {
      if (!row.CardCode) continue;
      await prisma.supplierCache.upsert({
        where: { cardcode: row.CardCode },
        create: {
          cardcode: row.CardCode,
          cardname: row.CardName ?? '',
          federaltaxid: row.FederalTaxID ?? null,
          vatregnum: row.VATRegistrationNumber ?? null,
        },
        update: {
          cardname: row.CardName ?? '',
          federaltaxid: row.FederalTaxID ?? null,
          vatregnum: row.VATRegistrationNumber ?? null,
          syncAt: new Date(),
        },
      });
      upserted++;
    }

    return reply.send({
      success: true,
      data: { upserted, total: sapRows.length },
    });
  });

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
          },
        },
      },
    },
    async (request, reply) => {
      const { cardCode, cardName, federalTaxId } = request.body;
      const { sapCookieHeader } = request.sapSession!;

      try {
        const result = await createBusinessPartner(sapCookieHeader, {
          cardCode,
          cardName,
          federalTaxId,
        });

        await prisma.supplierCache.upsert({
          where: { cardcode: result.cardCode },
          create: {
            cardcode: result.cardCode,
            cardname: cardName,
            federaltaxid: federalTaxId ?? null,
          },
          update: { cardname: cardName, federaltaxid: federalTaxId ?? null, syncAt: new Date() },
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
        return reply.code(httpStatus).send({ success: false, error: msg });
      }
    },
  );
}
