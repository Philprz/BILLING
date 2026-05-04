import type { FastifyInstance } from 'fastify';
import { requireSession } from '../middleware/require-session';
import {
  pingServiceLayer,
  searchChartOfAccounts,
  SapSlError,
  createSapUdfPaRef,
} from '../services/sap-sl.service';
import {
  listCachedAccounts,
  searchCachedAccounts,
  syncChartOfAccountsCache,
} from '../services/chart-of-accounts-cache.service';
import { listVatCodes, syncVatCodesFromSap } from '../services/sap-vat-code.service';
import { createAuditLogBestEffort } from '@pa-sap-bridge/database';

export async function sapRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/sap/ping ─────────────────────────────────────────────────────
  app.post('/api/sap/ping', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;
    const result = await pingServiceLayer(sapCookieHeader);
    return reply.send({ success: true, data: result });
  });

  // ── POST /api/sap/setup/udf-pa-ref ────────────────────────────────────────
  app.post('/api/sap/setup/udf-pa-ref', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;
    try {
      const result = await createSapUdfPaRef(sapCookieHeader);
      return reply.send({ success: true, data: result });
    } catch (err) {
      const msg =
        err instanceof SapSlError
          ? err.sapDetail
          : err instanceof Error
            ? err.message
            : String(err);
      const code = err instanceof SapSlError ? err.httpStatus : 502;
      return reply.code(code).send({ success: false, error: msg });
    }
  });

  // ── GET /api/sap/accounts/search?q=... ────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>(
    '/api/sap/accounts/search',
    { preHandler: requireSession },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim();
      if (q.length < 1) {
        return reply.send({ success: true, data: [] });
      }
      const { sapCookieHeader } = request.sapSession!;
      try {
        // Recherche directement dans SAP B1 (ActiveAccount + Postable)
        const accounts = await searchChartOfAccounts(sapCookieHeader, q);
        return reply.send({ success: true, data: accounts });
      } catch (err) {
        // Fallback sur le cache local si SAP est injoignable
        try {
          const cached = await searchCachedAccounts(q);
          return reply.send({ success: true, data: cached });
        } catch {
          const msg =
            err instanceof SapSlError
              ? err.sapDetail
              : err instanceof Error
                ? err.message
                : String(err);
          const code = err instanceof SapSlError ? err.httpStatus : 502;
          return reply.code(code).send({ success: false, error: msg });
        }
      }
    },
  );

  // ── GET /api/sap/chart-of-accounts?search=... (ou ?q=...) ─────────────────
  // Accepte aussi bien le paramètre "search" (spec) que "q" (rétrocompatibilité).
  app.get<{ Querystring: { q?: string; search?: string } }>(
    '/api/sap/chart-of-accounts',
    { preHandler: requireSession },
    async (request, reply) => {
      try {
        const q = (request.query.search ?? request.query.q ?? '').trim();
        const accounts = q ? await searchCachedAccounts(q) : await listCachedAccounts();
        return reply.send({ success: true, data: accounts });
      } catch (err) {
        const msg =
          err instanceof SapSlError
            ? err.sapDetail
            : err instanceof Error
              ? err.message
              : String(err);
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );

  // ── POST /api/sap/chart-of-accounts/sync ───────────────────────────────────
  app.post(
    '/api/sap/chart-of-accounts/sync',
    { preHandler: requireSession },
    async (request, reply) => {
      const { sapCookieHeader, sapUser } = request.sapSession!;
      try {
        const result = await syncChartOfAccountsCache(sapCookieHeader);
        await createAuditLogBestEffort({
          action: 'CONFIG_CHANGE',
          entityType: 'CONFIG',
          entityId: 'chart_of_accounts_cache',
          sapUser,
          outcome: 'OK',
          payloadAfter: {
            syncedCount: result.count,
            activePostable: result.activePostable,
            syncedAt: result.syncedAt.toISOString(),
          },
          ipAddress: request.ip,
          userAgent:
            typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent']
              : null,
        });
        return reply.send({
          success: true,
          data: {
            imported: result.count,
            activePostable: result.activePostable,
            syncedAt: result.syncedAt.toISOString(),
          },
        });
      } catch (err) {
        const msg =
          err instanceof SapSlError
            ? err.sapDetail
            : err instanceof Error
              ? err.message
              : String(err);
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );

  // ── GET /api/sap/vat-codes ─────────────────────────────────────────────────
  app.get('/api/sap/vat-codes', { preHandler: requireSession }, async (_request, reply) => {
    try {
      const codes = await listVatCodes();
      return reply.send({ success: true, data: codes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ success: false, error: msg });
    }
  });

  // ── POST /api/sap/vat-codes/sync ──────────────────────────────────────────
  app.post('/api/sap/vat-codes/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader, sapUser } = request.sapSession!;
    try {
      const result = await syncVatCodesFromSap(sapCookieHeader);
      await createAuditLogBestEffort({
        action: 'CONFIG_CHANGE',
        entityType: 'CONFIG',
        entityId: 'vat_group_cache',
        sapUser,
        outcome: 'OK',
        payloadAfter: { imported: result.imported, source: result.source },
        ipAddress: request.ip,
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      });
      return reply.send({ success: true, data: result });
    } catch (err) {
      const msg =
        err instanceof SapSlError
          ? err.sapDetail
          : err instanceof Error
            ? err.message
            : String(err);
      const code = err instanceof SapSlError ? err.httpStatus : 502;
      return reply.code(code).send({ success: false, error: msg });
    }
  });
}
