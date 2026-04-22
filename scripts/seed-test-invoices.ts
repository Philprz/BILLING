/**
 * 5 factures de démonstration couvrant tous les statuts du workflow.
 * Idempotent sur paMessageId — relancer ne crée pas de doublons.
 * Usage : npm run seed:test
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

// ─── Définition des 5 factures ────────────────────────────────────────────────

const TEST_INVOICES = [

  // ── 1. NEW ────────────────────────────────────────────────────────────────
  // Facture PDF arrivée par SFTP, fournisseur jamais vu, pas de lignes extraites.
  // Cas : flux entrant brut, en attente de traitement.
  {
    invoice: {
      paMessageId: 'TEST-01-new',
      paSource: 'SEED_TEST',
      direction: 'INVOICE' as const,
      format: 'PDF_ONLY' as const,
      supplierPaIdentifier: 'FR77889900112',
      supplierNameRaw: 'Plomberie Rénovation Dupont',
      supplierB1Cardcode: null,
      supplierMatchConfidence: 0,
      docNumberPa: 'PRD-2026-0047',
      docDate: new Date('2026-04-15'),
      dueDate: new Date('2026-05-15'),
      currency: 'EUR',
      totalExclTax: 2340.00,
      totalTax: 468.00,
      totalInclTax: 2808.00,
      status: 'NEW' as const,
    },
    lines: [],
    files: [
      {
        kind: 'PDF' as const,
        path: '/data/invoices/PRD-2026-0047.pdf',
        sizeBytes: BigInt(620_000),
        sha256: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b',
      },
    ],
  },

  // ── 2. TO_REVIEW ──────────────────────────────────────────────────────────
  // Fournisseur reconnu à 45 % seulement, lignes extraites mais sans compte suggéré.
  // Cas : opérateur doit valider le mapping fournisseur et saisir les comptes.
  {
    invoice: {
      paMessageId: 'TEST-02-to-review',
      paSource: 'SEED_TEST',
      direction: 'INVOICE' as const,
      format: 'UBL' as const,
      supplierPaIdentifier: 'FR44556677889',
      supplierNameRaw: 'Informatique & Services LEBRUN',
      supplierB1Cardcode: null,
      supplierMatchConfidence: 45,
      docNumberPa: 'ISL-2026-0112',
      docDate: new Date('2026-04-10'),
      dueDate: new Date('2026-05-10'),
      currency: 'EUR',
      totalExclTax: 3600.00,
      totalTax: 720.00,
      totalInclTax: 4320.00,
      status: 'TO_REVIEW' as const,
      statusReason: 'Confiance fournisseur insuffisante (45 %) — vérification manuelle requise',
    },
    lines: [
      {
        lineNo: 1,
        description: 'Maintenance annuelle parc informatique (30 postes)',
        quantity: 30,
        unitPrice: 80.00,
        amountExclTax: 2400.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 480.00,
        amountInclTax: 2880.00,
        suggestedAccountCode: null as string | null,
        suggestedAccountConfidence: 0,
      },
      {
        lineNo: 2,
        description: 'Remplacement écrans défectueux x3',
        quantity: 3,
        unitPrice: 400.00,
        amountExclTax: 1200.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 240.00,
        amountInclTax: 1440.00,
        suggestedAccountCode: null as string | null,
        suggestedAccountConfidence: 0,
      },
    ],
    files: [
      {
        kind: 'PDF' as const,
        path: '/data/invoices/ISL-2026-0112.pdf',
        sizeBytes: BigInt(410_000),
        sha256: '2b3c4d5e6f7a2b3c4d5e6f7a2b3c4d5e6f7a2b3c4d5e6f7a2b3c4d5e6f7a2b3c',
      },
      {
        kind: 'XML' as const,
        path: '/data/invoices/ISL-2026-0112.xml',
        sizeBytes: BigInt(22_000),
        sha256: '3c4d5e6f7a8b3c4d5e6f7a8b3c4d5e6f7a8b3c4d5e6f7a8b3c4d5e6f7a8b3c4d',
      },
    ],
  },

  // ── 3. READY ──────────────────────────────────────────────────────────────
  // Fournisseur SAP identifié, lignes avec compte suggéré et compte choisi.
  // Cas : prête à envoyer à SAP B1, en attente du clic "Intégrer".
  {
    invoice: {
      paMessageId: 'TEST-03-ready',
      paSource: 'SEED_TEST',
      direction: 'INVOICE' as const,
      format: 'FACTUR_X' as const,
      supplierPaIdentifier: 'FR22334455667',
      supplierNameRaw: 'Fournitures Bureau MARTIN',
      supplierB1Cardcode: 'F_MARTIN01',
      supplierMatchConfidence: 98,
      docNumberPa: 'FBM-2026-0330',
      docDate: new Date('2026-04-18'),
      dueDate: new Date('2026-05-18'),
      currency: 'EUR',
      totalExclTax: 756.00,
      totalTax: 151.20,
      totalInclTax: 907.20,
      status: 'READY' as const,
    },
    lines: [
      {
        lineNo: 1,
        description: 'Ramettes papier A4 80g (carton de 5)',
        quantity: 20,
        unitPrice: 18.00,
        amountExclTax: 360.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 72.00,
        amountInclTax: 432.00,
        suggestedAccountCode: '606100' as string | null,
        suggestedAccountConfidence: 96,
        suggestedCostCenter: 'ADM' as string | null,
        suggestedTaxCodeB1: 'S1' as string | null,
        suggestionSource: 'Règle fournisseur F_MARTIN01 — mot-clé "papier" (+8) — compte 606100 (score 96/100)' as string | null,
        chosenAccountCode: '606100' as string | null,
        chosenCostCenter: 'ADM' as string | null,
        chosenTaxCodeB1: 'S1' as string | null,
      },
      {
        lineNo: 2,
        description: 'Cartouches imprimante HP 305 — lot de 4',
        quantity: 6,
        unitPrice: 66.00,
        amountExclTax: 396.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 79.20,
        amountInclTax: 475.20,
        suggestedAccountCode: '606100' as string | null,
        suggestedAccountConfidence: 91,
        suggestedCostCenter: 'ADM' as string | null,
        suggestedTaxCodeB1: 'S1' as string | null,
        suggestionSource: 'Règle fournisseur F_MARTIN01 — mot-clé "cartouche" (+6) — compte 606100 (score 91/100)' as string | null,
        chosenAccountCode: '606100' as string | null,
        chosenCostCenter: 'ADM' as string | null,
        chosenTaxCodeB1: 'S1' as string | null,
      },
    ],
    files: [
      {
        kind: 'PDF' as const,
        path: '/data/invoices/FBM-2026-0330.pdf',
        sizeBytes: BigInt(195_000),
        sha256: '4d5e6f7a8b9c4d5e6f7a8b9c4d5e6f7a8b9c4d5e6f7a8b9c4d5e6f7a8b9c4d5e',
      },
      {
        kind: 'XML' as const,
        path: '/data/invoices/FBM-2026-0330.xml',
        sizeBytes: BigInt(15_500),
        sha256: '5e6f7a8b9c0d5e6f7a8b9c0d5e6f7a8b9c0d5e6f7a8b9c0d5e6f7a8b9c0d5e6f',
      },
    ],
  },

  // ── 4. POSTED ─────────────────────────────────────────────────────────────
  // Intégrée en SAP B1 (mode SERVICE_INVOICE), statut retourné à la PA.
  // Cas : flux complet terminé, consultation post-intégration.
  {
    invoice: {
      paMessageId: 'TEST-04-posted',
      paSource: 'SEED_TEST',
      direction: 'INVOICE' as const,
      format: 'FACTUR_X' as const,
      supplierPaIdentifier: 'FR99001122334',
      supplierNameRaw: 'Nettoyage Pro Services',
      supplierB1Cardcode: 'F_NPS01',
      supplierMatchConfidence: 100,
      docNumberPa: 'NPS-2026-0156',
      docDate: new Date('2026-04-05'),
      dueDate: new Date('2026-05-05'),
      currency: 'EUR',
      totalExclTax: 1200.00,
      totalTax: 240.00,
      totalInclTax: 1440.00,
      status: 'POSTED' as const,
      integrationMode: 'SERVICE_INVOICE' as const,
      sapDocEntry: 2031,
      sapDocNum: 2031,
      paStatusSentAt: new Date('2026-04-19T09:14:22.000Z'),
    },
    lines: [
      {
        lineNo: 1,
        description: 'Prestation nettoyage locaux — avril 2026',
        quantity: 1,
        unitPrice: 1200.00,
        amountExclTax: 1200.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 240.00,
        amountInclTax: 1440.00,
        suggestedAccountCode: '614100' as string | null,
        suggestedAccountConfidence: 100,
        suggestedCostCenter: 'GEN' as string | null,
        suggestedTaxCodeB1: 'S1' as string | null,
        suggestionSource: 'Règle fournisseur F_NPS01 — compte 614100 (score 100/100)' as string | null,
        chosenAccountCode: '614100' as string | null,
        chosenCostCenter: 'GEN' as string | null,
        chosenTaxCodeB1: 'S1' as string | null,
      },
    ],
    files: [
      {
        kind: 'PDF' as const,
        path: '/data/invoices/NPS-2026-0156.pdf',
        sizeBytes: BigInt(278_000),
        sha256: '6f7a8b9c0d1e6f7a8b9c0d1e6f7a8b9c0d1e6f7a8b9c0d1e6f7a8b9c0d1e6f7a',
      },
    ],
  },

  // ── 5. REJECTED ───────────────────────────────────────────────────────────
  // Doublon détecté par l'opérateur, rejetée avec motif détaillé.
  // Cas : test du workflow de rejet et affichage du motif en UI.
  {
    invoice: {
      paMessageId: 'TEST-05-rejected',
      paSource: 'SEED_TEST',
      direction: 'INVOICE' as const,
      format: 'UBL' as const,
      supplierPaIdentifier: 'FR33445566778',
      supplierNameRaw: 'Transport Express DURAND',
      supplierB1Cardcode: 'F_TED01',
      supplierMatchConfidence: 87,
      docNumberPa: 'TED-2026-0089',
      docDate: new Date('2026-04-12'),
      dueDate: new Date('2026-05-12'),
      currency: 'EUR',
      totalExclTax: 890.00,
      totalTax: 178.00,
      totalInclTax: 1068.00,
      status: 'REJECTED' as const,
      statusReason: 'Doublon — facture identique déjà intégrée le 05/04/2026 (SAP doc. 1987, PA ref. TED-2026-0089)',
      paStatusSentAt: new Date('2026-04-20T14:30:00.000Z'),
    },
    lines: [
      {
        lineNo: 1,
        description: 'Transport marchandises Paris–Lyon (lot 12)',
        quantity: 1,
        unitPrice: 890.00,
        amountExclTax: 890.00,
        taxCode: 'TVA20',
        taxRate: 20.0,
        taxAmount: 178.00,
        amountInclTax: 1068.00,
        suggestedAccountCode: '624100' as string | null,
        suggestedAccountConfidence: 83,
        suggestedTaxCodeB1: 'S1' as string | null,
        suggestionSource: 'Règle fournisseur F_TED01 — mot-clé "transport" (+7) — compte 624100 (score 83/100)' as string | null,
      },
    ],
    files: [
      {
        kind: 'PDF' as const,
        path: '/data/invoices/TED-2026-0089.pdf',
        sizeBytes: BigInt(185_000),
        sha256: '7a8b9c0d1e2f7a8b9c0d1e2f7a8b9c0d1e2f7a8b9c0d1e2f7a8b9c0d1e2f7a8b',
      },
      {
        kind: 'XML' as const,
        path: '/data/invoices/TED-2026-0089.xml',
        sizeBytes: BigInt(12_800),
        sha256: '8b9c0d1e2f3a8b9c0d1e2f3a8b9c0d1e2f3a8b9c0d1e2f3a8b9c0d1e2f3a8b9c',
      },
    ],
  },
];

// ─── Insertion ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[SeedTest] Insertion des 5 factures de test…\n');

  for (const fixture of TEST_INVOICES) {
    const existing = await prisma.invoice.findUnique({
      where: { paMessageId: fixture.invoice.paMessageId },
    });

    if (existing) {
      console.log(`  ↷ ${fixture.invoice.paMessageId} — déjà présent, ignoré`);
      continue;
    }

    await prisma.invoice.create({
      data: {
        ...fixture.invoice,
        lines: {
          create: fixture.lines.map((l) => ({
            lineNo: l.lineNo,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amountExclTax: l.amountExclTax,
            taxCode: l.taxCode ?? null,
            taxRate: l.taxRate ?? null,
            taxAmount: l.taxAmount,
            amountInclTax: l.amountInclTax,
            suggestedAccountCode: l.suggestedAccountCode ?? null,
            suggestedAccountConfidence: l.suggestedAccountConfidence ?? 0,
            suggestedCostCenter: l.suggestedCostCenter ?? null,
            suggestedTaxCodeB1: l.suggestedTaxCodeB1 ?? null,
            suggestionSource: l.suggestionSource ?? null,
            chosenAccountCode: l.chosenAccountCode ?? null,
            chosenCostCenter: l.chosenCostCenter ?? null,
            chosenTaxCodeB1: l.chosenTaxCodeB1 ?? null,
          })),
        },
        files: {
          create: fixture.files,
        },
      },
    });

    const statusPad = fixture.invoice.status.padEnd(10);
    console.log(`  ✓ ${fixture.invoice.paMessageId.padEnd(24)} [${statusPad}] ${fixture.invoice.supplierNameRaw}`);
  }

  console.log('\n[SeedTest] Terminé.\n');
  console.log('  Filtre UI : paSource = SEED_TEST');
  console.log('  Suppression : DELETE FROM invoices WHERE pa_source = \'SEED_TEST\';\n');
}

main()
  .catch((err: unknown) => {
    console.error('[SeedTest] ERREUR :', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
