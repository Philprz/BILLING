/**
 * Migration : renseigner mapping_rules.tax_code_b1 en s'appuyant sur le cache
 * SAP (vat_group_cache) + l'analyse des taux de TVA observés sur les factures
 * réelles.
 *
 * Idempotent : ne modifie QUE les règles avec tax_code_b1 NULL ou vide.
 *
 * Algorithme de choix pour chaque règle vide :
 *   1. Si la règle a un matchTaxRate → cherche dans vat_group_cache un code
 *      actif (Category=bovcInputTax en priorité) avec ce taux.
 *   2. Sinon, regarde le taux TVA le plus fréquent sur invoice_lines (jointure
 *      par fournisseur si la règle est SUPPLIER, sinon toutes lignes) et
 *      résout via le cache.
 *   3. Sinon, fallback codé en défaut : code S1 (TVA 20%) si présent et actif
 *      dans le cache, sinon laisse vide (avec avertissement).
 *
 * Usage :
 *   npx tsx scripts/migrate-vat-mapping-rules.ts            # dry-run
 *   npx tsx scripts/migrate-vat-mapping-rules.ts --apply    # exécute les UPDATE
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const DEFAULT_CODE = 'S1';

const prisma = new PrismaClient();

interface VatCacheEntry {
  code: string;
  rate: number;
  active: boolean;
  category: string | null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function ratesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function pickInputTax(entries: VatCacheEntry[]): VatCacheEntry | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  const inputs = entries.filter((e) => e.category === 'bovcInputTax');
  if (inputs.length === 1) return inputs[0];
  // Sinon, on prend par ordre alphabétique du code pour stabilité
  return [...entries].sort((a, b) => a.code.localeCompare(b.code))[0];
}

async function loadVatCache(): Promise<VatCacheEntry[]> {
  const rows = await prisma.vatGroupCache.findMany({
    where: { active: true },
    orderBy: [{ rate: 'asc' }, { code: 'asc' }],
  });
  return rows.map((r) => ({
    code: r.code,
    rate: Number(r.rate),
    active: r.active,
    category: r.category,
  }));
}

function lookupByRate(cache: VatCacheEntry[], rate: number): VatCacheEntry | null {
  const matches = cache.filter((e) => ratesEqual(e.rate, rate));
  return pickInputTax(matches);
}

function lookupByCode(cache: VatCacheEntry[], code: string): VatCacheEntry | null {
  return cache.find((e) => e.code === code) ?? null;
}

async function dominantRateForSupplier(cardcode: string): Promise<number | null> {
  // Lignes de facture liées au fournisseur (toutes statuts confondus)
  const rows = await prisma.invoiceLine.findMany({
    where: {
      taxRate: { not: null },
      invoice: { supplierB1Cardcode: cardcode },
    },
    select: { taxRate: true },
  });
  return computeDominantRate(rows.map((r) => Number(r.taxRate)));
}

async function dominantRateGlobal(): Promise<number | null> {
  const rows = await prisma.invoiceLine.findMany({
    where: { taxRate: { not: null } },
    select: { taxRate: true },
  });
  return computeDominantRate(rows.map((r) => Number(r.taxRate)));
}

function computeDominantRate(rates: number[]): number | null {
  if (rates.length === 0) return null;
  const counts = new Map<string, { rate: number; count: number }>();
  for (const r of rates) {
    const key = r.toFixed(2);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { rate: r, count: 1 });
  }
  let best: { rate: number; count: number } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best?.rate ?? null;
}

interface PlannedUpdate {
  ruleId: string;
  supplier: string;
  keyword: string;
  matchRate: number | null;
  newCode: string;
  reason: string;
}

async function main(): Promise<void> {
  console.log('=== Migration tax_code_b1 sur mapping_rules ===');
  console.log(`Mode : ${APPLY ? 'APPLY (UPDATE en DB)' : 'DRY-RUN (lecture seule)'}\n`);

  const cache = await loadVatCache();
  if (cache.length === 0) {
    console.error(
      'vat_group_cache est vide — lancer d\'abord "Resynchroniser les codes TVA SAP" dans les paramètres.',
    );
    process.exit(2);
  }
  console.log(`Codes TVA disponibles (${cache.length}) :`);
  for (const c of cache) {
    console.log(`  ${pad(c.code, 6)} ${pad(c.rate.toFixed(2) + '%', 8)} ${c.category ?? '—'}`);
  }
  console.log('');

  const defaultEntry = lookupByCode(cache, DEFAULT_CODE);
  if (!defaultEntry) {
    console.warn(
      `⚠ Code par défaut "${DEFAULT_CODE}" absent ou inactif dans le cache — les règles sans signal seront laissées vides.\n`,
    );
  }

  const allRules = await prisma.mappingRule.findMany({
    orderBy: [{ supplierCardcode: 'asc' }, { matchKeyword: 'asc' }],
  });
  const empty = allRules.filter((r) => !r.taxCodeB1 || r.taxCodeB1.trim() === '');
  console.log(`Règles totales : ${allRules.length} — dont vides : ${empty.length}\n`);

  if (empty.length === 0) {
    console.log('→ Rien à migrer (toutes les règles ont déjà un code TVA).');
    return;
  }

  console.log(
    [pad('ID', 38), pad('Fournisseur', 12), pad('Compte', 10), pad('Mot-clé', 26), 'Décision'].join(
      ' | ',
    ),
  );
  console.log('-'.repeat(140));

  const planned: PlannedUpdate[] = [];
  const stats = {
    byMatchRate: 0,
    bySupplierDominant: 0,
    byGlobalDominant: 0,
    byDefault: 0,
    skippedNoCandidate: 0,
  };

  for (const r of empty) {
    const supplier = r.supplierCardcode ?? '(GLOBAL)';
    const kw = r.matchKeyword ?? '—';
    const rateNum = r.matchTaxRate !== null ? Number(r.matchTaxRate) : null;

    let chosen: VatCacheEntry | null = null;
    let reason = '';

    if (rateNum !== null) {
      chosen = lookupByRate(cache, rateNum);
      if (chosen) {
        reason = `matchTaxRate=${rateNum}% → ${chosen.code} (${chosen.rate}%)`;
        stats.byMatchRate++;
      }
    }

    if (!chosen) {
      if (r.scope === 'SUPPLIER' && r.supplierCardcode) {
        const dom = await dominantRateForSupplier(r.supplierCardcode);
        if (dom !== null) {
          const c = lookupByRate(cache, dom);
          if (c) {
            chosen = c;
            reason = `taux dominant fournisseur=${dom}% → ${c.code}`;
            stats.bySupplierDominant++;
          }
        }
      }
    }

    if (!chosen) {
      const dom = await dominantRateGlobal();
      if (dom !== null) {
        const c = lookupByRate(cache, dom);
        if (c) {
          chosen = c;
          reason = `taux dominant global=${dom}% → ${c.code}`;
          stats.byGlobalDominant++;
        }
      }
    }

    if (!chosen && defaultEntry) {
      chosen = defaultEntry;
      reason = `défaut → ${defaultEntry.code} (${defaultEntry.rate}%)`;
      stats.byDefault++;
    }

    if (!chosen) {
      reason = 'aucun candidat (laissée vide)';
      stats.skippedNoCandidate++;
      console.log(
        [
          pad(r.id, 38),
          pad(supplier, 12),
          pad(r.accountCode, 10),
          pad(kw.slice(0, 26), 26),
          '✗ ' + reason,
        ].join(' | '),
      );
      continue;
    }

    planned.push({
      ruleId: r.id,
      supplier,
      keyword: kw,
      matchRate: rateNum,
      newCode: chosen.code,
      reason,
    });

    console.log(
      [
        pad(r.id, 38),
        pad(supplier, 12),
        pad(r.accountCode, 10),
        pad(kw.slice(0, 26), 26),
        '→ ' + reason,
      ].join(' | '),
    );
  }

  console.log('');
  console.log('Résumé prévisionnel :');
  console.log(`  Par matchTaxRate           : ${stats.byMatchRate}`);
  console.log(`  Par taux dominant fournisseur : ${stats.bySupplierDominant}`);
  console.log(`  Par taux dominant global   : ${stats.byGlobalDominant}`);
  console.log(`  Par code par défaut (${DEFAULT_CODE})    : ${stats.byDefault}`);
  console.log(`  Laissées vides             : ${stats.skippedNoCandidate}`);
  console.log(`  TOTAL à mettre à jour      : ${planned.length}\n`);

  if (!APPLY) {
    console.log('→ Dry-run terminé. Relancer avec --apply pour exécuter les UPDATE.');
    return;
  }

  if (planned.length === 0) {
    console.log('→ Aucun UPDATE à exécuter.');
    return;
  }

  console.log(`→ APPLY : exécution de ${planned.length} UPDATE…`);
  let ok = 0;
  let errors = 0;
  await prisma.$transaction(async (tx) => {
    for (const p of planned) {
      try {
        await tx.mappingRule.update({
          where: { id: p.ruleId },
          data: { taxCodeB1: p.newCode },
        });
        ok++;
      } catch (err) {
        errors++;
        console.error(
          `  ✗ ${p.ruleId} → ${p.newCode} : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  });
  console.log(`  ✓ ${ok} règle(s) mises à jour, ${errors} erreur(s).\n`);

  // Vérification post-update
  const after = await prisma.mappingRule.findMany({
    where: { id: { in: planned.map((p) => p.ruleId) } },
    select: { id: true, taxCodeB1: true },
  });
  let mismatch = 0;
  for (const p of planned) {
    const row = after.find((x) => x.id === p.ruleId);
    if (row?.taxCodeB1 !== p.newCode) {
      console.log(`  ✗ ${p.ruleId} attendu=${p.newCode} obtenu=${row?.taxCodeB1 ?? '(null)'}`);
      mismatch++;
    }
  }
  console.log(
    `  Vérification : ${mismatch === 0 ? '✓ tous conformes' : `✗ ${mismatch} divergence(s)`}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error('\nERREUR :', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
