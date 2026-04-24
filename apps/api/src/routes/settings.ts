import type { FastifyInstance } from 'fastify';
import {
  findBasicSettings,
  findAllSettings,
  upsertSetting,
  ALL_EDITABLE_KEYS,
  type EditableSettingKey,
} from '../repositories/setting.repository';
import { requireSession } from '../middleware/require-session';
import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import { pingServiceLayer } from '../services/sap-sl.service';

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

export async function settingRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/settings/basic ─────────────────────────────────────────────────
  app.get('/api/settings/basic', { preHandler: requireSession }, async (_req, reply) => {
    const settings = await findBasicSettings();
    return reply.send({ success: true, data: settings });
  });

  // ── GET /api/settings ───────────────────────────────────────────────────────
  app.get('/api/settings', { preHandler: requireSession }, async (_req, reply) => {
    const settings = await findAllSettings();
    return reply.send({ success: true, data: settings });
  });

  // ── PUT /api/settings/:key ──────────────────────────────────────────────────
  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/settings/:key',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['value'],
          properties: { value: {} },
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params;
      const { sapUser } = request.sapSession!;

      if (!ALL_EDITABLE_KEYS.includes(key as EditableSettingKey)) {
        return reply.code(400).send({
          success: false,
          error: `Clé inconnue ou non éditable : "${key}". Acceptées : ${ALL_EDITABLE_KEYS.join(', ')}.`,
        });
      }

      const previous = await prisma.setting.findUnique({ where: { key } });
      const updated = await upsertSetting(key as EditableSettingKey, request.body.value);

      await createAuditLogBestEffort({
        action: 'CONFIG_CHANGE',
        entityType: 'INVOICE',
        entityId: key,
        sapUser,
        outcome: 'OK',
        payloadBefore: previous ? { value: previous.value } : null,
        payloadAfter: { value: updated.value },
        ...getRequestMeta(request),
      });

      return reply.send({ success: true, data: updated });
    },
  );

  // ── POST /api/settings/test-sap ─────────────────────────────────────────────
  app.post('/api/settings/test-sap', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader } = request.sapSession!;
    const result = await pingServiceLayer(sapCookieHeader);
    return reply.send({ success: true, data: result });
  });
}
