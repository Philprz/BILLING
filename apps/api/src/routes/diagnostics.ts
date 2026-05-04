import type { FastifyInstance } from 'fastify';
import { requireSession } from '../middleware/require-session';
import { prisma } from '@pa-sap-bridge/database';

export async function diagnosticsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/diagnostics/sap-references
   *
   * Retourne l'état du cache plan comptable et des codes TVA.
   * Utile pour diagnostiquer l'affectation comptable automatique.
   */
  app.get(
    '/api/diagnostics/sap-references',
    { preHandler: requireSession },
    async (_request, reply) => {
      // ── Plan comptable ────────────────────────────────────────────────────────
      let chartCount = 0;
      let chartSample: Array<{
        acctCode: string;
        acctName: string;
        postable: boolean;
        active: boolean;
      }> = [];
      let chartSource: 'cache' | 'empty' = 'empty';

      try {
        chartCount = await prisma.chartOfAccountCache.count({
          where: { activeAccount: true, postable: true },
        });

        app.log.info(
          { count: chartCount },
          '[diagnostics] Comptes SAP actifs+imputables dans le cache',
        );

        const totalCount = await prisma.chartOfAccountCache.count();
        app.log.info(
          { total: totalCount, activePostable: chartCount },
          '[diagnostics] Plan comptable — total comptes en cache vs actifs+imputables',
        );

        if (chartCount > 0) {
          chartSource = 'cache';
          const rows = await prisma.chartOfAccountCache.findMany({
            where: { activeAccount: true, postable: true },
            take: 3,
            orderBy: { acctCode: 'asc' },
          });
          chartSample = rows.map((r) => ({
            acctCode: r.acctCode,
            acctName: r.acctName,
            postable: r.postable,
            active: r.activeAccount,
          }));
        }
      } catch (err) {
        app.log.error({ err }, '[diagnostics] Erreur lecture cache plan comptable');
      }

      // ── Codes TVA ─────────────────────────────────────────────────────────────
      let vatCount = 0;
      let vatSample: Array<{ code: string; rate: number; name: string }> = [];
      let vatSource: 'cache' | 'settings' | 'empty' = 'empty';

      try {
        vatCount = await prisma.vatGroupCache.count({ where: { active: true } });

        app.log.info({ count: vatCount }, '[diagnostics] Codes TVA actifs dans le cache');

        if (vatCount > 0) {
          vatSource = 'cache';
          const rows = await prisma.vatGroupCache.findMany({
            where: { active: true },
            take: 5,
            orderBy: [{ rate: 'asc' }, { code: 'asc' }],
          });
          vatSample = rows.map((r) => ({
            code: r.code,
            rate: Number(r.rate),
            name: r.name,
          }));
        } else {
          // Fallback : lire le mapping settings
          const setting = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
          if (
            setting?.value &&
            typeof setting.value === 'object' &&
            !Array.isArray(setting.value)
          ) {
            const map = setting.value as Record<string, string>;
            const entries = Object.entries(map);
            vatCount = entries.length;
            if (vatCount > 0) {
              vatSource = 'settings';
              vatSample = entries.slice(0, 5).map(([rateStr, code]) => ({
                code,
                rate: parseFloat(rateStr),
                name: `TVA ${rateStr}%`,
              }));
            }
          }
          app.log.info(
            { source: vatSource, count: vatCount },
            '[diagnostics] Codes TVA depuis settings (cache vide)',
          );
        }
      } catch (err) {
        app.log.error({ err }, '[diagnostics] Erreur lecture cache codes TVA');
      }

      return reply.send({
        success: true,
        data: {
          chartOfAccounts: {
            source: chartSource,
            count: chartCount,
            sample: chartSample,
          },
          vatCodes: {
            source: vatSource,
            count: vatCount,
            sample: vatSample,
          },
        },
      });
    },
  );
}
