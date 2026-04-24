import type { FastifyInstance } from 'fastify';
import { requireSession } from '../middleware/require-session';
import { prisma, createAuditLogBestEffort } from '@pa-sap-bridge/database';

// Champs sensibles masqués dans les réponses (ne jamais renvoyer les credentials en clair)
function sanitize(ch: Record<string, unknown>) {
  return {
    ...ch,
    passwordEncrypted: ch.passwordEncrypted ? '••••••••' : null,
    apiCredentialsEncrypted: ch.apiCredentialsEncrypted ? '••••••••' : null,
  };
}

interface CreateBody {
  name: string;
  protocol: 'SFTP' | 'API';
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  remotePathIn?: string | null;
  remotePathProcessed?: string | null;
  remotePathOut?: string | null;
  apiBaseUrl?: string | null;
  apiAuthType?: 'BASIC' | 'API_KEY' | 'OAUTH2' | null;
  apiCredentials?: string | null;
  pollIntervalSeconds?: number;
  active?: boolean;
}

interface PatchBody {
  name?: string;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  remotePathIn?: string | null;
  remotePathProcessed?: string | null;
  remotePathOut?: string | null;
  apiBaseUrl?: string | null;
  apiAuthType?: 'BASIC' | 'API_KEY' | 'OAUTH2' | null;
  apiCredentials?: string | null;
  pollIntervalSeconds?: number;
  active?: boolean;
}

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

export async function paChannelRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/pa-channels ────────────────────────────────────────────────────
  app.get('/api/pa-channels', { preHandler: requireSession }, async (_req, reply) => {
    const channels = await prisma.paChannel.findMany({ orderBy: { name: 'asc' } });
    return reply.send({ success: true, data: channels.map(sanitize) });
  });

  // ── POST /api/pa-channels ───────────────────────────────────────────────────
  app.post<{ Body: CreateBody }>(
    '/api/pa-channels',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'protocol'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            protocol: { type: 'string', enum: ['SFTP', 'API'] },
            host: { type: ['string', 'null'], maxLength: 255 },
            port: { type: ['number', 'null'], minimum: 1, maximum: 65535 },
            user: { type: ['string', 'null'], maxLength: 100 },
            password: { type: ['string', 'null'], maxLength: 500 },
            remotePathIn: { type: ['string', 'null'], maxLength: 500 },
            remotePathProcessed: { type: ['string', 'null'], maxLength: 500 },
            remotePathOut: { type: ['string', 'null'], maxLength: 500 },
            apiBaseUrl: { type: ['string', 'null'], maxLength: 500 },
            apiAuthType: { type: ['string', 'null'], enum: ['BASIC', 'API_KEY', 'OAUTH2', null] },
            apiCredentials: { type: ['string', 'null'], maxLength: 2000 },
            pollIntervalSeconds: { type: 'number', minimum: 10, maximum: 86400 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { sapUser } = request.sapSession!;
      const b = request.body;

      const channel = await prisma.paChannel.create({
        data: {
          name: b.name,
          protocol: b.protocol,
          host: b.host ?? null,
          port: b.port ?? null,
          user: b.user ?? null,
          passwordEncrypted: b.password ?? null,
          remotePathIn: b.remotePathIn ?? null,
          remotePathProcessed: b.remotePathProcessed ?? null,
          remotePathOut: b.remotePathOut ?? null,
          apiBaseUrl: b.apiBaseUrl ?? null,
          apiAuthType: b.apiAuthType ?? null,
          apiCredentialsEncrypted: b.apiCredentials ?? null,
          pollIntervalSeconds: b.pollIntervalSeconds ?? 60,
          active: b.active ?? true,
        },
      });

      await createAuditLogBestEffort({
        action: 'CONFIG_CHANGE',
        entityType: 'INVOICE',
        entityId: channel.id,
        sapUser,
        outcome: 'OK',
        payloadAfter: { name: channel.name, protocol: channel.protocol },
        ...getRequestMeta(request),
      });

      return reply
        .code(201)
        .send({ success: true, data: sanitize(channel as unknown as Record<string, unknown>) });
    },
  );

  // ── PATCH /api/pa-channels/:id ──────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/api/pa-channels/:id',
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
            name: { type: 'string', minLength: 1, maxLength: 100 },
            host: { type: ['string', 'null'], maxLength: 255 },
            port: { type: ['number', 'null'], minimum: 1, maximum: 65535 },
            user: { type: ['string', 'null'], maxLength: 100 },
            password: { type: ['string', 'null'], maxLength: 500 },
            remotePathIn: { type: ['string', 'null'], maxLength: 500 },
            remotePathProcessed: { type: ['string', 'null'], maxLength: 500 },
            remotePathOut: { type: ['string', 'null'], maxLength: 500 },
            apiBaseUrl: { type: ['string', 'null'], maxLength: 500 },
            apiAuthType: { type: ['string', 'null'], enum: ['BASIC', 'API_KEY', 'OAUTH2', null] },
            apiCredentials: { type: ['string', 'null'], maxLength: 2000 },
            pollIntervalSeconds: { type: 'number', minimum: 10, maximum: 86400 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser } = request.sapSession!;
      const b = request.body;

      const existing = await prisma.paChannel.findUnique({ where: { id } });
      if (!existing)
        return reply.code(404).send({ success: false, error: 'Canal PA introuvable.' });

      const updated = await prisma.paChannel.update({
        where: { id },
        data: {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.host !== undefined ? { host: b.host } : {}),
          ...(b.port !== undefined ? { port: b.port } : {}),
          ...(b.user !== undefined ? { user: b.user } : {}),
          ...(b.password !== undefined ? { passwordEncrypted: b.password } : {}),
          ...(b.remotePathIn !== undefined ? { remotePathIn: b.remotePathIn } : {}),
          ...(b.remotePathProcessed !== undefined
            ? { remotePathProcessed: b.remotePathProcessed }
            : {}),
          ...(b.remotePathOut !== undefined ? { remotePathOut: b.remotePathOut } : {}),
          ...(b.apiBaseUrl !== undefined ? { apiBaseUrl: b.apiBaseUrl } : {}),
          ...(b.apiAuthType !== undefined ? { apiAuthType: b.apiAuthType } : {}),
          ...(b.apiCredentials !== undefined ? { apiCredentialsEncrypted: b.apiCredentials } : {}),
          ...(b.pollIntervalSeconds !== undefined
            ? { pollIntervalSeconds: b.pollIntervalSeconds }
            : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
        },
      });

      await createAuditLogBestEffort({
        action: 'CONFIG_CHANGE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { name: existing.name, active: existing.active },
        payloadAfter: { name: updated.name, active: updated.active },
        ...getRequestMeta(request),
      });

      return reply.send({
        success: true,
        data: sanitize(updated as unknown as Record<string, unknown>),
      });
    },
  );

  // ── DELETE /api/pa-channels/:id ─────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/pa-channels/:id',
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

      const existing = await prisma.paChannel.findUnique({ where: { id } });
      if (!existing)
        return reply.code(404).send({ success: false, error: 'Canal PA introuvable.' });

      await prisma.paChannel.delete({ where: { id } });

      await createAuditLogBestEffort({
        action: 'CONFIG_CHANGE',
        entityType: 'INVOICE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { name: existing.name, protocol: existing.protocol },
        payloadAfter: { deleted: true },
        ...getRequestMeta(request),
      });

      return reply.send({ success: true });
    },
  );
}
