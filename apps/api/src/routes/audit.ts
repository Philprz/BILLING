import type { FastifyInstance } from 'fastify';
import { buildAuditSummary, prisma } from '@pa-sap-bridge/database';
import { requireSession } from '../middleware/require-session';

const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGOUT',
  'FETCH_PA',
  'VIEW_INVOICE',
  'EDIT_MAPPING',
  'APPROVE',
  'REJECT',
  'POST_SAP',
  'SEND_STATUS_PA',
  'SYSTEM_ERROR',
  'CONFIG_CHANGE',
] as const;
const AUDIT_OUTCOMES = ['OK', 'ERROR'] as const;
const ENTITY_TYPES = ['INVOICE', 'RULE', 'CONFIG', 'SYSTEM', 'ATTACHMENT'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AuditListQuery {
  page?: number;
  limit?: number;
  entityId?: string;
  action?: string;
  outcome?: string;
  entityType?: string;
  dateFrom?: string;
  dateTo?: string;
}

function buildAuditWhere(q: Omit<AuditListQuery, 'page' | 'limit'>) {
  return {
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.action ? { action: q.action as (typeof AUDIT_ACTIONS)[number] } : {}),
    ...(q.outcome ? { outcome: q.outcome as (typeof AUDIT_OUTCOMES)[number] } : {}),
    ...(q.entityType ? { entityType: q.entityType as (typeof ENTITY_TYPES)[number] } : {}),
    ...(q.dateFrom || q.dateTo
      ? {
          occurredAt: {
            ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}),
            ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59Z`) } : {}),
          },
        }
      : {}),
  };
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/audit/export.csv  (avant /api/audit pour éviter collision de route)
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: Omit<AuditListQuery, 'page' | 'limit'> }>(
    '/api/audit/export.csv',
    { preHandler: requireSession },
    async (request, reply) => {
      const where = buildAuditWhere(request.query);
      const entries = await prisma.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: 10000,
        select: {
          occurredAt: true,
          action: true,
          entityType: true,
          entityId: true,
          outcome: true,
          sapUser: true,
          errorMessage: true,
        },
      });

      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const header = 'Date,Action,TypeEntite,IDEntite,Resultat,Utilisateur,Erreur\r\n';
      const rows = entries.map((e) =>
        [
          e.occurredAt.toISOString(),
          e.action,
          e.entityType,
          esc(e.entityId ?? ''),
          e.outcome,
          esc(e.sapUser ?? ''),
          esc(e.errorMessage ?? ''),
        ].join(','),
      );

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="audit.csv"');
      return reply.send('﻿' + header + rows.join('\r\n'));
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/audit
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: AuditListQuery }>(
    '/api/audit',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            entityId: { type: 'string', maxLength: 100 },
            action: { type: 'string', enum: [...AUDIT_ACTIONS] },
            outcome: { type: 'string', enum: [...AUDIT_OUTCOMES] },
            entityType: { type: 'string', enum: [...ENTITY_TYPES] },
            dateFrom: { type: 'string', format: 'date' },
            dateTo: { type: 'string', format: 'date' },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const skip = (page - 1) * limit;

      const where = buildAuditWhere(q);

      const [entries, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            occurredAt: true,
            sapUser: true,
            action: true,
            entityType: true,
            entityId: true,
            outcome: true,
            errorMessage: true,
            payloadBefore: true,
            payloadAfter: true,
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      const totalPages = Math.ceil(total / limit);

      return reply.send({
        success: true,
        data: {
          items: entries.map((e) => ({
            ...e,
            occurredAt: e.occurredAt.toISOString(),
            summary: buildAuditSummary({
              action: e.action,
              outcome: e.outcome,
              payloadBefore: e.payloadBefore,
              payloadAfter: e.payloadAfter,
              errorMessage: e.errorMessage,
            }),
          })),
          total,
          page,
          limit,
          totalPages,
        },
      });
    },
  );
}
