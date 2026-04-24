import type { FastifyInstance } from 'fastify';
import { requireSession } from '../middleware/require-session';
import { pingServiceLayer, fetchChartOfAccounts, SapSlError } from '../services/sap-sl.service';

export async function sapRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/sap/ping ─────────────────────────────────────────────────────
  app.post('/api/sap/ping', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;
    const result = await pingServiceLayer(sapCookieHeader);
    return reply.send({ success: true, data: result });
  });

  // ── GET /api/sap/chart-of-accounts ─────────────────────────────────────────
  app.get('/api/sap/chart-of-accounts', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;
    try {
      const accounts = await fetchChartOfAccounts(sapCookieHeader);
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
  });
}
