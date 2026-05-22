/**
 * Backfill mapping_rules.tax_code_b1 à partir de match_tax_rate
 * en s'appuyant sur le mapping TAX_RATE_MAPPING (settings).
 *
 * Usage :
 *   npx tsx scripts/backfill-mapping-rules-tax-code.ts            # dry-run (défaut)
 *   npx tsx scripts/backfill-mapping-rules-tax-code.ts --apply    # applique les UPDATE
 *
 * Règles :
 *  - Ne met à jour QUE les règles avec tax_code_b1 vide/null
 *  - Ignore les règles dont match_tax_rate est null (laisse vide)
 *  - Affecte la valeur depuis settings.TAX_RATE_MAPPING (clés "20.00","10.00",…)
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

async function loadTaxRateMap(): Promise<Record<string, string>> {
  const row = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
  if (!row || typeof row.value !== 'object' || Array.isArray(row.value) || row.value === null) {
    throw new Error('Setting TAX_RATE_MAPPING introuvable ou format invalide');
  }
  return row.value as Record<string, string>;
}

function normalizeRateKey(rate: Prisma.Decimal | null): string | null {
  if (rate === null) return null;
  return Number(rate).toFixed(2);
}

function lookupCode(map: Record<string, string>, rate: Prisma.Decimal | null): string | null {
  const key = normalizeRateKey(rate);
  if (key === null) return null;
  if (map[key]) return map[key];
  // tolère "20" pour "20.00" et "20.0" pour "20.00"
  const alt1 = String(Number(key)); // "20"
  const alt2 = Number(key).toFixed(1); // "20.0"
  return map[alt1] ?? map[alt2] ?? null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log('=== Backfill mapping_rules.tax_code_b1 ===');
  console.log(`Mode : ${APPLY ? 'APPLY (UPDATE en DB)' : 'DRY-RUN (lecture seule)'}`);
  console.log('');

  const taxRateMap = await loadTaxRateMap();
  console.log('Mapping TAX_RATE_MAPPING (settings) :');
  for (const [k, v] of Object.entries(taxRateMap)) {
    console.log(`  ${pad(k, 8)} → ${v}`);
  }
  console.log('');

  const rules = await prisma.mappingRule.findMany({
    orderBy: [{ supplierCardcode: 'asc' }, { matchKeyword: 'asc' }],
  });

  console.log(`Règles totales : ${rules.length}`);
  console.log('');
  console.log(
    [
      pad('ID', 38),
      pad('Fournisseur', 14),
      pad('Mot-clé', 30),
      pad('Taux', 7),
      pad('Code actuel', 12),
      'Code prévu',
    ].join(' | '),
  );
  console.log('-'.repeat(120));

  const planned: { id: string; code: string }[] = [];
  const stats = { willUpdate: 0, alreadySet: 0, noRate: 0, noMatchInMap: 0 };

  for (const r of rules) {
    const supplier = r.supplierCardcode ?? '(GLOBAL)';
    const kw = r.matchKeyword ?? '—';
    const rateLabel = r.matchTaxRate !== null ? `${Number(r.matchTaxRate)}%` : '—';
    const current = r.taxCodeB1 ?? '(vide)';

    let planned_code = '';
    if (r.taxCodeB1 && r.taxCodeB1.trim() !== '') {
      planned_code = `(déjà ${r.taxCodeB1})`;
      stats.alreadySet++;
    } else if (r.matchTaxRate === null) {
      planned_code = '(aucun — taux non défini)';
      stats.noRate++;
    } else {
      const code = lookupCode(taxRateMap, r.matchTaxRate);
      if (!code) {
        planned_code = `(taux ${Number(r.matchTaxRate)} absent du mapping)`;
        stats.noMatchInMap++;
      } else {
        planned_code = code;
        stats.willUpdate++;
        planned.push({ id: r.id, code });
      }
    }

    console.log(
      [
        pad(r.id, 38),
        pad(supplier, 14),
        pad(kw.slice(0, 30), 30),
        pad(rateLabel, 7),
        pad(current, 12),
        planned_code,
      ].join(' | '),
    );
  }

  console.log('');
  console.log('Résumé prévisionnel :');
  console.log(`  À mettre à jour          : ${stats.willUpdate}`);
  console.log(`  Déjà renseignées         : ${stats.alreadySet}`);
  console.log(`  Sans taux (laissées)     : ${stats.noRate}`);
  console.log(`  Taux hors mapping        : ${stats.noMatchInMap}`);
  console.log('');

  if (!APPLY) {
    console.log('→ Dry-run terminé. Relancer avec --apply pour exécuter les UPDATE.');
    return;
  }

  if (planned.length === 0) {
    console.log('→ Aucun UPDATE à exécuter.');
    return;
  }

  console.log(`→ APPLY : exécution de ${planned.length} UPDATE ciblés…`);
  let ok = 0;
  let errors = 0;
  await prisma.$transaction(async (tx) => {
    for (const { id, code } of planned) {
      try {
        await tx.mappingRule.update({
          where: { id },
          data: { taxCodeB1: code, updatedAt: new Date() },
        });
        ok++;
      } catch (err) {
        errors++;
        console.error(`  ✗ ${id} → ${code} : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  console.log(`  ✓ ${ok} règle(s) mises à jour, ${errors} erreur(s).`);
  console.log('');

  // Vérification post-update
  console.log('Vérification post-update :');
  const after = await prisma.mappingRule.findMany({
    where: { id: { in: planned.map((p) => p.id) } },
    select: { id: true, taxCodeB1: true, matchTaxRate: true },
  });
  let mismatch = 0;
  for (const p of planned) {
    const row = after.find((x) => x.id === p.id);
    if (row?.taxCodeB1 !== p.code) {
      console.log(`  ✗ ${p.id} : attendu ${p.code}, obtenu ${row?.taxCodeB1 ?? '(null)'}`);
      mismatch++;
    }
  }
  console.log(`  ${mismatch === 0 ? '✓ tous conformes' : `✗ ${mismatch} divergence(s)`}`);
}

main()
  .catch((err: unknown) => {
    console.error('\nERREUR :', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
