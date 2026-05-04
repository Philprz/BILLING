import type { FastifyInstance } from 'fastify';
import { requireSession } from '../middleware/require-session';
import { prisma, createAuditLogBestEffort } from '@pa-sap-bridge/database';
import type { MappingScope } from '@pa-sap-bridge/database';
import { checkTaxCodesExist, checkCostCentersExist } from '../services/sap-reference.service';
import {
  validateCachedAccount,
  isCachePopulated,
} from '../services/chart-of-accounts-cache.service';

interface CreateRuleBody {
  scope: 'GLOBAL' | 'SUPPLIER';
  supplierCardcode?: string | null;
  matchKeyword?: string | null;
  matchTaxRate?: number | null;
  matchAmountMin?: number | null;
  matchAmountMax?: number | null;
  accountCode: string;
  costCenter?: string | null;
  taxCodeB1?: string | null;
  confidence?: number;
}

interface PatchRuleBody {
  scope?: 'GLOBAL' | 'SUPPLIER';
  supplierCardcode?: string | null;
  matchKeyword?: string | null;
  matchTaxRate?: number | null;
  accountCode?: string;
  costCenter?: string | null;
  taxCodeB1?: string | null;
  confidence?: number;
  active?: boolean;
}

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

interface SapRefErrors {
  accountCode?: string;
  taxCodeB1?: string;
  costCenter?: string;
}

async function validateRefsAgainstSap(
  sapCookieHeader: string,
  accountCode: string | undefined,
  taxCodeB1: string | null | undefined,
  costCenter: string | null | undefined,
): Promise<SapRefErrors> {
  const errors: SapRefErrors = {};

  const cacheReady = await isCachePopulated();
  const [accountResult, taxResult, costCenterResult] = await Promise.all([
    accountCode && cacheReady ? validateCachedAccount(accountCode) : null,
    taxCodeB1 ? checkTaxCodesExist(sapCookieHeader, [taxCodeB1]) : null,
    costCenter ? checkCostCentersExist(sapCookieHeader, [costCenter]) : null,
  ]);

  if (accountCode && !cacheReady) {
    errors.accountCode = `Plan comptable non synchronisé — synchronisez d'abord le plan comptable SAP B1 dans les Paramètres avant de créer une règle.`;
  } else if (accountResult && !accountResult.ok) {
    errors.accountCode = `${accountResult.reason} : ${accountCode}`;
  }
  if (taxResult?.missing.length) {
    errors.taxCodeB1 = `Code TVA introuvable dans SAP B1 : ${taxResult.missing.join(', ')}`;
  }
  if (costCenterResult?.missing.length) {
    errors.costCenter = `Centre de coût introuvable dans SAP B1 : ${costCenterResult.missing.join(', ')}`;
  }

  return errors;
}

export async function mappingRuleRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/mapping-rules ──────────────────────────────────────────────────
  app.get('/api/mapping-rules', { preHandler: requireSession }, async (_req, reply) => {
    const rules = await prisma.mappingRule.findMany({
      orderBy: [{ scope: 'desc' }, { confidence: 'desc' }, { usageCount: 'desc' }],
    });
    return reply.send({ success: true, data: rules });
  });

  // ── POST /api/mapping-rules ─────────────────────────────────────────────────
  app.post<{ Body: CreateRuleBody }>(
    '/api/mapping-rules',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['scope', 'accountCode'],
          properties: {
            scope: { type: 'string', enum: ['GLOBAL', 'SUPPLIER'] },
            supplierCardcode: { type: ['string', 'null'], maxLength: 50 },
            matchKeyword: { type: ['string', 'null'], maxLength: 200 },
            matchTaxRate: { type: ['number', 'null'] },
            matchAmountMin: { type: ['number', 'null'] },
            matchAmountMax: { type: ['number', 'null'] },
            accountCode: { type: 'string', minLength: 1, maxLength: 20 },
            costCenter: { type: ['string', 'null'], maxLength: 20 },
            taxCodeB1: { type: ['string', 'null'], maxLength: 20 },
            confidence: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { sapUser, sapCookieHeader } = request.sapSession!;
      const body = request.body;

      if (body.scope === 'SUPPLIER' && !body.supplierCardcode) {
        return reply
          .code(422)
          .send({ success: false, error: 'supplierCardcode obligatoire pour une règle SUPPLIER.' });
      }

      // Validation des références SAP
      const sapErrors = await validateRefsAgainstSap(
        sapCookieHeader,
        body.accountCode,
        body.taxCodeB1,
        body.costCenter,
      );

      if (Object.keys(sapErrors).length > 0) {
        return reply.code(422).send({
          success: false,
          error: Object.values(sapErrors).join(' — '),
          data: { sapErrors },
        });
      }

      const rule = await prisma.mappingRule.create({
        data: {
          scope: body.scope,
          supplierCardcode: body.scope === 'SUPPLIER' ? body.supplierCardcode : null,
          matchKeyword: body.matchKeyword ?? null,
          matchTaxRate: body.matchTaxRate ?? null,
          matchAmountMin: body.matchAmountMin ?? null,
          matchAmountMax: body.matchAmountMax ?? null,
          accountCode: body.accountCode,
          costCenter: body.costCenter ?? null,
          taxCodeB1: body.taxCodeB1 ?? null,
          confidence: body.confidence ?? 60,
          createdByUser: sapUser,
        },
      });

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'RULE',
        entityId: rule.id,
        sapUser,
        outcome: 'OK',
        payloadAfter: { ...body, createdByUser: sapUser },
        ...getRequestMeta(request),
      });

      return reply.code(201).send({ success: true, data: rule });
    },
  );

  // ── PATCH /api/mapping-rules/:id ────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: PatchRuleBody }>(
    '/api/mapping-rules/:id',
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
            scope: { type: 'string', enum: ['GLOBAL', 'SUPPLIER'] },
            supplierCardcode: { type: ['string', 'null'], maxLength: 50 },
            matchKeyword: { type: ['string', 'null'], maxLength: 200 },
            matchTaxRate: { type: ['number', 'null'] },
            accountCode: { type: 'string', minLength: 1, maxLength: 20 },
            costCenter: { type: ['string', 'null'], maxLength: 20 },
            taxCodeB1: { type: ['string', 'null'], maxLength: 20 },
            confidence: { type: 'number', minimum: 0, maximum: 100 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sapUser, sapCookieHeader } = request.sapSession!;

      const existing = await prisma.mappingRule.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ success: false, error: 'Règle introuvable.' });

      const {
        scope,
        supplierCardcode,
        matchKeyword,
        matchTaxRate,
        accountCode,
        costCenter,
        taxCodeB1,
        confidence,
        active,
      } = request.body;

      // Cohérence scope/supplierCardcode
      const newScope = scope ?? existing.scope;
      const newSupplierCardcode =
        newScope === 'GLOBAL'
          ? null
          : supplierCardcode !== undefined
            ? supplierCardcode
            : existing.supplierCardcode;
      if (newScope === 'SUPPLIER' && !newSupplierCardcode) {
        return reply
          .code(422)
          .send({ success: false, error: 'supplierCardcode obligatoire pour une règle SUPPLIER.' });
      }

      // Valider uniquement les champs SAP modifiés
      const accountToCheck =
        accountCode !== undefined && accountCode !== existing.accountCode ? accountCode : undefined;
      const taxToCheck =
        taxCodeB1 !== undefined && taxCodeB1 !== existing.taxCodeB1 ? taxCodeB1 : undefined;
      const centerToCheck =
        costCenter !== undefined && costCenter !== existing.costCenter ? costCenter : undefined;

      if (accountToCheck !== undefined || taxToCheck !== undefined || centerToCheck !== undefined) {
        const sapErrors = await validateRefsAgainstSap(
          sapCookieHeader,
          accountToCheck,
          taxToCheck,
          centerToCheck,
        );

        if (Object.keys(sapErrors).length > 0) {
          return reply.code(422).send({
            success: false,
            error: Object.values(sapErrors).join(' — '),
            data: { sapErrors },
          });
        }
      }

      const updated = await prisma.mappingRule.update({
        where: { id },
        data: {
          ...(scope !== undefined ? { scope, supplierCardcode: newSupplierCardcode } : {}),
          ...(supplierCardcode !== undefined && scope === undefined
            ? { supplierCardcode: newSupplierCardcode }
            : {}),
          ...(matchKeyword !== undefined ? { matchKeyword } : {}),
          ...(matchTaxRate !== undefined ? { matchTaxRate } : {}),
          ...(accountCode !== undefined ? { accountCode } : {}),
          ...(costCenter !== undefined ? { costCenter } : {}),
          ...(taxCodeB1 !== undefined ? { taxCodeB1 } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          ...(active !== undefined ? { active } : {}),
        },
      });

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'RULE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: {
          accountCode: existing.accountCode,
          confidence: existing.confidence,
          active: existing.active,
        },
        payloadAfter: {
          accountCode: updated.accountCode,
          confidence: updated.confidence,
          active: updated.active,
        },
        ...getRequestMeta(request),
      });

      return reply.send({ success: true, data: updated });
    },
  );

  // ── DELETE /api/mapping-rules/:id ───────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/mapping-rules/:id',
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

      const existing = await prisma.mappingRule.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ success: false, error: 'Règle introuvable.' });

      await prisma.mappingRule.delete({ where: { id } });

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'RULE',
        entityId: id,
        sapUser,
        outcome: 'OK',
        payloadBefore: { accountCode: existing.accountCode, scope: existing.scope },
        payloadAfter: { deleted: true },
        ...getRequestMeta(request),
      });

      return reply.send({ success: true });
    },
  );

  // ── POST /api/mapping-rules/test ────────────────────────────────────────────
  // Simule l'application des règles sur un libellé + montant + TVA fictifs.
  app.post<{
    Body: {
      description: string;
      amountExclTax?: number;
      taxRate?: number | null;
      supplierCardcode?: string | null;
    };
  }>(
    '/api/mapping-rules/test',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string', maxLength: 500 },
            amountExclTax: { type: 'number' },
            taxRate: { type: ['number', 'null'] },
            supplierCardcode: { type: ['string', 'null'], maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { description, amountExclTax, taxRate, supplierCardcode } = request.body;
      const rules = await prisma.mappingRule.findMany({
        where: { active: true },
        orderBy: [{ scope: 'desc' }, { confidence: 'desc' }],
      });

      type RuleWithScore = (typeof rules)[0] & { score: number };
      const candidates: RuleWithScore[] = [];

      for (const rule of rules) {
        if (rule.scope === 'SUPPLIER' && rule.supplierCardcode !== supplierCardcode) continue;
        if (
          rule.matchKeyword &&
          !description.toLowerCase().includes(rule.matchKeyword.toLowerCase())
        )
          continue;
        if (rule.matchTaxRate != null && taxRate != null && Number(rule.matchTaxRate) !== taxRate)
          continue;
        if (
          rule.matchAmountMin != null &&
          amountExclTax != null &&
          amountExclTax < Number(rule.matchAmountMin)
        )
          continue;
        if (
          rule.matchAmountMax != null &&
          amountExclTax != null &&
          amountExclTax > Number(rule.matchAmountMax)
        )
          continue;

        let score = rule.confidence;
        if (rule.scope === 'SUPPLIER') score += 20;
        if (rule.matchKeyword) score += 15;
        if (rule.matchTaxRate != null) score += 10;
        if (rule.matchAmountMin != null || rule.matchAmountMax != null) score += 5;
        candidates.push({ ...rule, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const winner = candidates[0] ?? null;

      return reply.send({
        success: true,
        data: {
          matched: winner != null,
          rule: winner
            ? {
                id: winner.id,
                scope: winner.scope,
                accountCode: winner.accountCode,
                costCenter: winner.costCenter,
                taxCodeB1: winner.taxCodeB1,
                confidence: winner.confidence,
                score: winner.score,
                matchKeyword: winner.matchKeyword,
              }
            : null,
          candidatesCount: candidates.length,
        },
      });
    },
  );

  // ── GET /api/mapping-rules/export.csv ──────────────────────────────────────
  app.get('/api/mapping-rules/export.csv', { preHandler: requireSession }, async (_req, reply) => {
    const rules = await prisma.mappingRule.findMany({
      orderBy: [{ scope: 'desc' }, { confidence: 'desc' }],
    });

    const HEADERS = [
      'scope',
      'supplierCardcode',
      'matchKeyword',
      'matchTaxRate',
      'matchAmountMin',
      'matchAmountMax',
      'accountCode',
      'costCenter',
      'taxCodeB1',
      'confidence',
      'active',
    ];
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const rows = [HEADERS.join(',')];
    for (const r of rules) {
      rows.push(
        [
          r.scope,
          r.supplierCardcode,
          r.matchKeyword,
          r.matchTaxRate,
          r.matchAmountMin,
          r.matchAmountMax,
          r.accountCode,
          r.costCenter,
          r.taxCodeB1,
          r.confidence,
          r.active,
        ]
          .map(escape)
          .join(','),
      );
    }

    void reply.header('Content-Type', 'text/csv; charset=utf-8');
    void reply.header('Content-Disposition', 'attachment; filename="mapping-rules.csv"');
    return reply.send(rows.join('\r\n'));
  });

  // ── POST /api/mapping-rules/import ─────────────────────────────────────────
  app.post<{ Body: { csv: string } }>(
    '/api/mapping-rules/import',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['csv'],
          properties: { csv: { type: 'string', maxLength: 500_000 } },
        },
      },
    },
    async (request, reply) => {
      const { sapUser } = request.sapSession!;
      const lines = request.body.csv.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2)
        return reply.code(422).send({ success: false, error: 'CSV vide ou invalide.' });

      const parseRow = (line: string): string[] => {
        const result: string[] = [];
        let cur = '',
          inQ = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') {
            if (inQ) {
              if (line[i + 1] === '"') {
                cur += '"';
                i++;
              } else {
                inQ = false;
              }
            } else {
              inQ = true;
            }
          } else if (c === ',' && !inQ) {
            result.push(cur);
            cur = '';
          } else cur += c;
        }
        result.push(cur);
        return result;
      };

      const header = parseRow(lines[0]).map((h) => h.trim().toLowerCase());
      const idx = (name: string) => header.indexOf(name);

      let created = 0,
        skipped = 0;
      for (const line of lines.slice(1)) {
        const cols = parseRow(line);
        const scope = cols[idx('scope')]?.trim() as MappingScope;
        const accountCode = cols[idx('accountcode')]?.trim();
        if (!scope || !accountCode || !['GLOBAL', 'SUPPLIER'].includes(scope)) {
          skipped++;
          continue;
        }

        await prisma.mappingRule.create({
          data: {
            scope,
            supplierCardcode: cols[idx('suppliercardcode')]?.trim() || null,
            matchKeyword: cols[idx('matchkeyword')]?.trim() || null,
            matchTaxRate: cols[idx('matchtaxrate')] ? Number(cols[idx('matchtaxrate')]) : null,
            matchAmountMin: cols[idx('matchamountmin')]
              ? Number(cols[idx('matchamountmin')])
              : null,
            matchAmountMax: cols[idx('matchamountmax')]
              ? Number(cols[idx('matchamountmax')])
              : null,
            accountCode,
            costCenter: cols[idx('costcenter')]?.trim() || null,
            taxCodeB1: cols[idx('taxcodeb1')]?.trim() || null,
            confidence: cols[idx('confidence')] ? Number(cols[idx('confidence')]) : 60,
            active: cols[idx('active')]?.trim() !== 'false',
            createdByUser: sapUser,
          },
        });
        created++;
      }

      await createAuditLogBestEffort({
        action: 'EDIT_MAPPING',
        entityType: 'RULE',
        entityId: null,
        sapUser,
        outcome: 'OK',
        payloadAfter: { importedCount: created, skippedCount: skipped },
        ipAddress: request.ip,
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      });

      return reply.send({ success: true, data: { created, skipped } });
    },
  );
}
