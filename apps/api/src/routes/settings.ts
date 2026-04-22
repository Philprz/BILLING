import type { FastifyInstance } from 'fastify';
import { findBasicSettings } from '../repositories/setting.repository';
import { requireSession } from '../middleware/require-session';

export async function settingRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/settings/basic
  // Retourne le sous-ensemble de clés de configuration utiles au front-end.
  // ────────────────────────────────────────────────────────────────────────────
  app.get('/api/settings/basic', { preHandler: requireSession }, async (_req, reply) => {
    const settings = await findBasicSettings();
    return reply.send({ success: true, data: settings });
  });
}
