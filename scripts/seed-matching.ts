/**
 * Seed : suppliers_cache + mapping_rules
 * Idempotent — ne recrée pas ce qui existe déjà.
 *
 * Usage : npm run seed:matching
 */

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { prisma } from '../packages/database/src/client';

// ─── Fournisseurs ─────────────────────────────────────────────────────────────

const SUPPLIERS = [
  {
    cardcode:     'F_ACME01',
    cardname:     'ACME Fournitures SAS',
    federaltaxid: '12345678901234',
    vatregnum:    'FR12345678901',
  },
  {
    cardcode:     'F_BUREAU01',
    cardname:     'Bureau Direct SAS',
    federaltaxid: '11223344556789',
    vatregnum:    'FR11223344556',
  },
  {
    cardcode:     'F_TECHSOL',
    cardname:     'Tech Solutions SARL',
    federaltaxid: '98765432109876',
    vatregnum:    'FR98765432109',
  },
  {
    cardcode:     'F_ELEC01',
    cardname:     'Électricité Maintenance Pro',
    federaltaxid: '55667788990123',
    vatregnum:    'FR55667788990',
  },
];

// ─── Règles de mapping ────────────────────────────────────────────────────────
// Chaque règle est identifiée par (scope + supplierCardcode + matchKeyword + matchTaxRate)
// pour assurer l'idempotence.

const RULES: Array<{
  scope: 'SUPPLIER' | 'GLOBAL';
  supplierCardcode?: string;
  matchKeyword?: string;
  matchTaxRate?: number;
  matchAmountMin?: number;
  matchAmountMax?: number;
  accountCode: string;
  costCenter?: string;
  taxCodeB1?: string;
  confidence: number;
  label: string;  // pour affichage uniquement
}> = [
  // ── Règles fournisseur : F_ACME01 ──
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_ACME01',
    matchKeyword: 'papier',
    accountCode: '606100', taxCodeB1: 'S1', confidence: 85,
    label: 'F_ACME01 + papier → 606100',
  },
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_ACME01',
    matchKeyword: 'stylo',
    accountCode: '606100', taxCodeB1: 'S1', confidence: 80,
    label: 'F_ACME01 + stylo → 606100',
  },
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_ACME01',
    matchKeyword: 'fournitures',
    accountCode: '606100', taxCodeB1: 'S1', confidence: 78,
    label: 'F_ACME01 + fournitures → 606100',
  },
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_ACME01',
    accountCode: '606000', confidence: 60,
    label: 'F_ACME01 catch-all → 606000',
  },
  // ── Règles fournisseur : F_BUREAU01 ──
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_BUREAU01',
    matchKeyword: 'avoir',
    accountCode: '609000', taxCodeB1: 'S1', confidence: 85,
    label: 'F_BUREAU01 + avoir → 609000',
  },
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_BUREAU01',
    accountCode: '606000', confidence: 60,
    label: 'F_BUREAU01 catch-all → 606000',
  },
  // ── Règles fournisseur : F_TECHSOL ──
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_TECHSOL',
    matchKeyword: 'logiciel',
    accountCode: '618500', taxCodeB1: 'S1', confidence: 88,
    label: 'F_TECHSOL + logiciel → 618500',
  },
  {
    scope: 'SUPPLIER', supplierCardcode: 'F_TECHSOL',
    matchKeyword: 'formation',
    accountCode: '618000', taxCodeB1: 'S1', confidence: 88,
    label: 'F_TECHSOL + formation → 618000',
  },
  // ── Règles globales ──
  {
    scope: 'GLOBAL', matchKeyword: 'papier',
    accountCode: '606100', confidence: 70,
    label: 'GLOBAL papier → 606100',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'fournitures',
    accountCode: '606100', confidence: 70,
    label: 'GLOBAL fournitures → 606100',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'logiciel',
    accountCode: '618500', confidence: 75,
    label: 'GLOBAL logiciel → 618500',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'formation',
    accountCode: '618000', confidence: 75,
    label: 'GLOBAL formation → 618000',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'conseil',
    accountCode: '622700', confidence: 70,
    label: 'GLOBAL conseil → 622700',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'prestation',
    accountCode: '622700', confidence: 65,
    label: 'GLOBAL prestation → 622700',
  },
  {
    scope: 'GLOBAL', matchKeyword: 'avoir',
    accountCode: '609000', confidence: 70,
    label: 'GLOBAL avoir → 609000',
  },
  {
    scope: 'GLOBAL', matchTaxRate: 20,
    accountCode: '606000', confidence: 40,
    label: 'GLOBAL TVA 20% → 606000 (filet de sécurité)',
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Seed suppliers_cache ===');
  for (const s of SUPPLIERS) {
    const existing = await prisma.supplierCache.findUnique({ where: { cardcode: s.cardcode } });
    if (existing) {
      console.log(`  SKIP ${s.cardcode} (existe déjà)`);
    } else {
      await prisma.supplierCache.create({ data: s });
      console.log(`  CRÉÉ ${s.cardcode} — ${s.cardname}`);
    }
  }

  console.log('\n=== Seed mapping_rules ===');
  for (const r of RULES) {
    // Clé d'idempotence : scope + supplierCardcode + matchKeyword + matchTaxRate
    const existing = await prisma.mappingRule.findFirst({
      where: {
        scope:            r.scope,
        supplierCardcode: r.supplierCardcode ?? null,
        matchKeyword:     r.matchKeyword     ?? null,
        matchTaxRate:     r.matchTaxRate     != null ? r.matchTaxRate : null,
      },
    });
    if (existing) {
      console.log(`  SKIP ${r.label}`);
    } else {
      await prisma.mappingRule.create({
        data: {
          scope:            r.scope,
          supplierCardcode: r.supplierCardcode ?? null,
          matchKeyword:     r.matchKeyword     ?? null,
          matchTaxRate:     r.matchTaxRate     ?? null,
          matchAmountMin:   r.matchAmountMin   ?? null,
          matchAmountMax:   r.matchAmountMax   ?? null,
          accountCode:      r.accountCode,
          costCenter:       r.costCenter       ?? null,
          taxCodeB1:        r.taxCodeB1        ?? null,
          confidence:       r.confidence,
          createdByUser:    'seed',
        },
      });
      console.log(`  CRÉÉ ${r.label}`);
    }
  }

  const [ruleCount, supplierCount] = await Promise.all([
    prisma.mappingRule.count(),
    prisma.supplierCache.count(),
  ]);
  console.log(`\nBilan : ${supplierCount} fournisseurs, ${ruleCount} règles en base.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
