/**
 * Service codes TVA SAP B1.
 *
 * Ordre de priorité pour la résolution d'un taux :
 *  1. Cache VatGroupCache (synchronisé depuis SAP VatGroups)
 *  2. Mapping explicite dans settings (TAX_RATE_MAPPING)
 *
 * Le cache est alimenté par syncVatCodesFromSap().
 * Si SAP ne fournit pas de codes TVA (VatGroups vide), le service se rabat
 * intégralement sur les settings.
 */

import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { fetchVatGroups } from './sap-sl.service';

export interface CachedVatGroup {
  code: string;
  name: string;
  rate: number;
  active: boolean;
}

export interface VatCodeResolution {
  code: string | null;
  name: string | null;
  rate: number | null;
  source: 'cache' | 'settings' | 'none';
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export async function syncVatCodesFromSap(
  sapSessionCookie: string,
): Promise<{ imported: number; source: 'sap' | 'empty' }> {
  const entries = await fetchVatGroups(sapSessionCookie);

  console.log(`[syncVatCodes] ${entries.length} groupe(s) TVA récupéré(s) depuis SAP`);

  if (entries.length === 0) {
    return { imported: 0, source: 'empty' };
  }

  const syncedAt = new Date();
  await prisma.$transaction(
    entries.map((e) =>
      prisma.vatGroupCache.upsert({
        where: { code: e.code },
        update: {
          name: e.name,
          rate: e.rate,
          active: e.active,
          raw: e.raw as Prisma.InputJsonValue,
          syncAt: syncedAt,
        },
        create: {
          code: e.code,
          name: e.name,
          rate: e.rate,
          active: e.active,
          raw: e.raw as Prisma.InputJsonValue,
          syncAt: syncedAt,
        },
      }),
    ),
  );

  return { imported: entries.length, source: 'sap' };
}

// ─── Liste ────────────────────────────────────────────────────────────────────

export async function listVatCodes(): Promise<CachedVatGroup[]> {
  const rows = await prisma.vatGroupCache.findMany({
    orderBy: [{ rate: 'asc' }, { code: 'asc' }],
  });
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    rate: Number(r.rate),
    active: r.active,
  }));
}

// ─── Résolution taux → code ───────────────────────────────────────────────────

/**
 * Résout le code TVA SAP à partir d'un taux (ex. 20.0 → 'S1').
 *
 * Priorité :
 *  1. Un seul code actif dans VatGroupCache pour ce taux → retourne ce code
 *  2. Mapping settings TAX_RATE_MAPPING (clé = taux formaté '20.00')
 *  3. Rien → { code: null, source: 'none' }
 *
 * Si plusieurs codes correspondent au même taux : retourne null + source='none'
 * (ambiguïté → l'utilisateur doit choisir).
 */
export async function resolveVatCodeFromRate(taxRate: number): Promise<VatCodeResolution> {
  // 1. Cherche dans le cache VatGroups
  const cacheRows = await prisma.vatGroupCache.findMany({
    where: { active: true, rate: taxRate },
    orderBy: { code: 'asc' },
  });

  if (cacheRows.length === 1) {
    const r = cacheRows[0];
    return { code: r.code, name: r.name, rate: Number(r.rate), source: 'cache' };
  }

  // Si plusieurs → ambiguïté, on tombe en fallback settings
  // 2. Settings TAX_RATE_MAPPING
  const setting = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
  if (setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)) {
    const map = setting.value as Record<string, string>;
    const key = taxRate.toFixed(2);
    if (map[key]) {
      const code = map[key];
      const cached = cacheRows.find((r) => r.code === code);
      return {
        code,
        name: cached?.name ?? null,
        rate: taxRate,
        source: 'settings',
      };
    }
  }

  return { code: null, name: null, rate: null, source: 'none' };
}

// ─── Validation ───────────────────────────────────────────────────────────────

export async function validateVatCode(
  code: string | null | undefined,
): Promise<{ ok: boolean; reason: string | null }> {
  if (!code?.trim()) return { ok: false, reason: 'Code TVA manquant' };

  const cached = await prisma.vatGroupCache.findUnique({ where: { code: code.trim() } });
  if (!cached) {
    // Si le cache est vide, on ne peut pas valider — on laisse passer (best-effort)
    const count = await prisma.vatGroupCache.count();
    if (count === 0) return { ok: true, reason: null };
    return { ok: false, reason: `Code TVA "${code}" absent du cache SAP B1` };
  }
  if (!cached.active) {
    return { ok: false, reason: `Code TVA "${code}" inactif dans SAP B1` };
  }
  return { ok: true, reason: null };
}

// ─── Fallback settings (mapping par défaut) ───────────────────────────────────

/** Retourne le mapping taux→code depuis les settings (TAX_RATE_MAPPING). */
export async function getTaxRateMappingFromSettings(): Promise<Record<string, string>> {
  const setting = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
  if (setting?.value && typeof setting.value === 'object' && !Array.isArray(setting.value)) {
    return setting.value as Record<string, string>;
  }
  return {};
}
