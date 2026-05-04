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
    cardcode: 'F_ACME01',
    cardname: 'ACME Fournitures SAS',
    federaltaxid: '12345678901234',
    vatregnum: 'FR12345678901',
    pa_identifier: 'PA-ACME-001',
  },
  {
    cardcode: 'F_BUREAU01',
    cardname: 'Bureau Direct SAS',
    federaltaxid: '11223344556789',
    vatregnum: 'FR11223344556',
    pa_identifier: 'PA-BUREAU-001',
  },
  {
    cardcode: 'F_TECHSOL',
    cardname: 'Tech Solutions SARL',
    federaltaxid: '98765432109876',
    vatregnum: 'FR98765432109',
    pa_identifier: 'PA-TECHSOL-001',
  },
  {
    cardcode: 'F_ELEC01',
    cardname: 'Électricité Maintenance Pro',
    federaltaxid: '55667788990123',
    vatregnum: 'FR55667788990',
    pa_identifier: 'PA-ELEC-001',
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
  label: string; // pour affichage uniquement
}> = [
  // ── Règles fournisseur : F_ACME01 ──
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_ACME01',
    matchKeyword: 'papier',
    accountCode: '606100',
    taxCodeB1: 'S1',
    confidence: 85,
    label: 'F_ACME01 + papier → 606100',
  },
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_ACME01',
    matchKeyword: 'stylo',
    accountCode: '606100',
    taxCodeB1: 'S1',
    confidence: 80,
    label: 'F_ACME01 + stylo → 606100',
  },
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_ACME01',
    matchKeyword: 'fournitures',
    accountCode: '606100',
    taxCodeB1: 'S1',
    confidence: 78,
    label: 'F_ACME01 + fournitures → 606100',
  },
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_ACME01',
    accountCode: '606000',
    confidence: 60,
    label: 'F_ACME01 catch-all → 606000',
  },
  // ── Règles fournisseur : F_BUREAU01 ──
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_BUREAU01',
    matchKeyword: 'avoir',
    accountCode: '609000',
    taxCodeB1: 'S1',
    confidence: 85,
    label: 'F_BUREAU01 + avoir → 609000',
  },
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_BUREAU01',
    accountCode: '606000',
    confidence: 60,
    label: 'F_BUREAU01 catch-all → 606000',
  },
  // ── Règles fournisseur : F_TECHSOL ──
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_TECHSOL',
    matchKeyword: 'logiciel',
    accountCode: '618500',
    taxCodeB1: 'S1',
    confidence: 88,
    label: 'F_TECHSOL + logiciel → 618500',
  },
  {
    scope: 'SUPPLIER',
    supplierCardcode: 'F_TECHSOL',
    matchKeyword: 'formation',
    accountCode: '618000',
    taxCodeB1: 'S1',
    confidence: 88,
    label: 'F_TECHSOL + formation → 618000',
  },
  // ── Règles globales ──
  {
    scope: 'GLOBAL',
    matchKeyword: 'papier',
    accountCode: '606100',
    confidence: 70,
    label: 'GLOBAL papier → 606100',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'fournitures',
    accountCode: '606100',
    confidence: 70,
    label: 'GLOBAL fournitures → 606100',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'logiciel',
    accountCode: '618500',
    confidence: 75,
    label: 'GLOBAL logiciel → 618500',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'formation',
    accountCode: '618000',
    confidence: 75,
    label: 'GLOBAL formation → 618000',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'conseil',
    accountCode: '622700',
    confidence: 70,
    label: 'GLOBAL conseil → 622700',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'prestation',
    accountCode: '622700',
    confidence: 65,
    label: 'GLOBAL prestation → 622700',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'avoir',
    accountCode: '609000',
    confidence: 70,
    label: 'GLOBAL avoir → 609000',
  },
  {
    scope: 'GLOBAL',
    matchTaxRate: 20,
    accountCode: '606000',
    confidence: 40,
    label: 'GLOBAL TVA 20% → 606000 (filet de sécurité)',
  },
  // ── Énergie / Électricité ──
  {
    scope: 'GLOBAL',
    matchKeyword: 'électricité',
    accountCode: '606200',
    confidence: 75,
    label: 'GLOBAL électricité → 606200',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'electricite',
    accountCode: '606200',
    confidence: 72,
    label: 'GLOBAL electricite (sans accent) → 606200',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'énergie',
    accountCode: '606200',
    confidence: 72,
    label: 'GLOBAL énergie → 606200',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'energie',
    accountCode: '606200',
    confidence: 70,
    label: 'GLOBAL energie (sans accent) → 606200',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'acheminement',
    accountCode: '606200',
    confidence: 70,
    label: 'GLOBAL acheminement → 606200',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'puissance',
    accountCode: '606200',
    confidence: 68,
    label: 'GLOBAL puissance → 606200',
  },
  // ── Maintenance / Entretien ──
  {
    scope: 'GLOBAL',
    matchKeyword: 'maintenance',
    accountCode: '615000',
    taxCodeB1: 'S1',
    confidence: 72,
    label: 'GLOBAL maintenance → 615000',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'entretien',
    accountCode: '615000',
    taxCodeB1: 'S1',
    confidence: 70,
    label: 'GLOBAL entretien → 615000',
  },
  // ── Hébergement / Cloud / Serveur ──
  {
    scope: 'GLOBAL',
    matchKeyword: 'hébergement',
    accountCode: '626300',
    taxCodeB1: 'S1',
    confidence: 70,
    label: 'GLOBAL hébergement → 626300',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'hebergement',
    accountCode: '626300',
    taxCodeB1: 'S1',
    confidence: 68,
    label: 'GLOBAL hebergement (sans accent) → 626300',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'cloud',
    accountCode: '618500',
    taxCodeB1: 'S1',
    confidence: 68,
    label: 'GLOBAL cloud → 618500',
  },
  {
    scope: 'GLOBAL',
    matchKeyword: 'serveur',
    accountCode: '618500',
    taxCodeB1: 'S1',
    confidence: 65,
    label: 'GLOBAL serveur → 618500',
  },
  // ── Consommables ──
  {
    scope: 'GLOBAL',
    matchKeyword: 'consommable',
    accountCode: '606100',
    taxCodeB1: 'S1',
    confidence: 68,
    label: 'GLOBAL consommable → 606100',
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Seed suppliers_cache ===');
  for (const s of SUPPLIERS) {
    await prisma.supplierCache.upsert({
      where: { cardcode: s.cardcode },
      create: s,
      update: { pa_identifier: s.pa_identifier },
    });
    console.log(`  UPSERT ${s.cardcode} — ${s.cardname}`);
  }

  console.log('\n=== Seed mapping_rules ===');
  for (const r of RULES) {
    // Clé d'idempotence : scope + supplierCardcode + matchKeyword + matchTaxRate
    const existing = await prisma.mappingRule.findFirst({
      where: {
        scope: r.scope,
        supplierCardcode: r.supplierCardcode ?? null,
        matchKeyword: r.matchKeyword ?? null,
        matchTaxRate: r.matchTaxRate != null ? r.matchTaxRate : null,
      },
    });
    if (existing) {
      console.log(`  SKIP ${r.label}`);
    } else {
      await prisma.mappingRule.create({
        data: {
          scope: r.scope,
          supplierCardcode: r.supplierCardcode ?? null,
          matchKeyword: r.matchKeyword ?? null,
          matchTaxRate: r.matchTaxRate ?? null,
          matchAmountMin: r.matchAmountMin ?? null,
          matchAmountMax: r.matchAmountMax ?? null,
          accountCode: r.accountCode,
          costCenter: r.costCenter ?? null,
          taxCodeB1: r.taxCodeB1 ?? null,
          confidence: r.confidence,
          createdByUser: 'seed',
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
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
