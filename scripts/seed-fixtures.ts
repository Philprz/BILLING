/**
 * Fixtures techniques pour tests de lecture (Lot 4).
 * Insère des factures avec lignes et fichiers — données réalistes mais fictives.
 * Idempotent sur paMessageId.
 * Usage : npm run seed:fixtures
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

const FIXTURES = [
  {
    invoice: {
      paMessageId: 'fixture-001',
      paSource: 'SFTP_DEMO',
      direction: 'INVOICE' as const,
      format: 'FACTUR_X' as const,
      supplierPaIdentifier: 'FR12345678901',
      supplierNameRaw: 'ACME Fournitures SAS',
      supplierB1Cardcode: 'F_ACME01',
      supplierMatchConfidence: 95,
      docNumberPa: 'FA-2026-001',
      docDate: new Date('2026-03-15'),
      dueDate: new Date('2026-04-15'),
      currency: 'EUR',
      totalExclTax: 1250.0,
      totalTax: 250.0,
      totalInclTax: 1500.0,
      status: 'READY' as const,
    },
    lines: [
      { lineNo: 1, description: 'Papier A4 ramette 500 feuilles x100', quantity: 100, unitPrice: 8.5, amountExclTax: 850.0, taxCode: 'TVA20', taxRate: 20.0, taxAmount: 170.0, amountInclTax: 1020.0, suggestedAccountCode: '606100', suggestedAccountConfidence: 88 },
      { lineNo: 2, description: 'Stylos bille bleu x200', quantity: 200, unitPrice: 2.0, amountExclTax: 400.0, taxCode: 'TVA20', taxRate: 20.0, taxAmount: 80.0, amountInclTax: 480.0, suggestedAccountCode: '606100', suggestedAccountConfidence: 82 },
    ],
    files: [
      { kind: 'PDF' as const, path: '/data/fixtures/fixture-001.pdf', sizeBytes: BigInt(245760), sha256: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd' },
      { kind: 'XML' as const, path: '/data/fixtures/fixture-001.xml', sizeBytes: BigInt(18432), sha256: 'def456abc123def456abc123def456abc123def456abc123def456abc123def4' },
    ],
  },
  {
    invoice: {
      paMessageId: 'fixture-002',
      paSource: 'SFTP_DEMO',
      direction: 'INVOICE' as const,
      format: 'UBL' as const,
      supplierPaIdentifier: 'FR98765432109',
      supplierNameRaw: 'Tech Solutions SARL',
      supplierB1Cardcode: null,
      supplierMatchConfidence: 42,
      docNumberPa: 'TS-2026-0089',
      docDate: new Date('2026-04-01'),
      dueDate: new Date('2026-05-01'),
      currency: 'EUR',
      totalExclTax: 5800.0,
      totalTax: 1160.0,
      totalInclTax: 6960.0,
      status: 'TO_REVIEW' as const,
      statusReason: 'Fournisseur non résolu dans SAP B1',
    },
    lines: [
      { lineNo: 1, description: 'Licence logiciel annuelle', quantity: 1, unitPrice: 4800.0, amountExclTax: 4800.0, taxCode: 'TVA20', taxRate: 20.0, taxAmount: 960.0, amountInclTax: 5760.0 },
      { lineNo: 2, description: 'Formation utilisateurs (2 jours)', quantity: 2, unitPrice: 500.0, amountExclTax: 1000.0, taxCode: 'TVA20', taxRate: 20.0, taxAmount: 200.0, amountInclTax: 1200.0 },
    ],
    files: [
      { kind: 'PDF' as const, path: '/data/fixtures/fixture-002.pdf', sizeBytes: BigInt(389120), sha256: '111222333444555666777888999000111222333444555666777888999000111a' },
    ],
  },
  {
    invoice: {
      paMessageId: 'fixture-003',
      paSource: 'API_PDP1',
      direction: 'CREDIT_NOTE' as const,
      format: 'FACTUR_X' as const,
      supplierPaIdentifier: 'FR11223344556',
      supplierNameRaw: 'Bureau Direct SAS',
      supplierB1Cardcode: 'F_BUREAU01',
      supplierMatchConfidence: 100,
      docNumberPa: 'AV-2026-007',
      docDate: new Date('2026-04-10'),
      dueDate: null,
      currency: 'EUR',
      totalExclTax: -320.0,
      totalTax: -64.0,
      totalInclTax: -384.0,
      status: 'POSTED' as const,
      sapDocEntry: 1042,
      sapDocNum: 1042,
    },
    lines: [
      { lineNo: 1, description: 'Avoir — retour marchandises défectueuses', quantity: 1, unitPrice: -320.0, amountExclTax: -320.0, taxCode: 'TVA20', taxRate: 20.0, taxAmount: -64.0, amountInclTax: -384.0, chosenAccountCode: '606100', chosenCostCenter: 'ADM' },
    ],
    files: [],
  },
  {
    invoice: {
      paMessageId: 'fixture-004',
      paSource: 'SFTP_DEMO',
      direction: 'INVOICE' as const,
      format: 'PDF_ONLY' as const,
      supplierPaIdentifier: 'FR55667788990',
      supplierNameRaw: 'Électricité Maintenance Pro',
      supplierB1Cardcode: null,
      supplierMatchConfidence: 0,
      docNumberPa: 'EMP-2026-0234',
      docDate: new Date('2026-04-18'),
      dueDate: new Date('2026-05-18'),
      currency: 'EUR',
      totalExclTax: 890.0,
      totalTax: 178.0,
      totalInclTax: 1068.0,
      status: 'NEW' as const,
    },
    lines: [],
    files: [
      { kind: 'PDF' as const, path: '/data/fixtures/fixture-004.pdf', sizeBytes: BigInt(512000), sha256: 'aaaabbbbccccddddeeeeffffaaaabbbbccccddddeeeeffffaaaabbbbccccdddd' },
    ],
  },
];

async function main(): Promise<void> {
  console.log('[Fixtures] Démarrage…');

  for (const fixture of FIXTURES) {
    const existing = await prisma.invoice.findUnique({
      where: { paMessageId: fixture.invoice.paMessageId },
    });

    if (existing) {
      console.log(`[Fixtures]   ↷ ${fixture.invoice.paMessageId} déjà présent, ignoré`);
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
    console.log(`[Fixtures]   ✓ ${fixture.invoice.paMessageId} — ${fixture.invoice.supplierNameRaw} (${fixture.invoice.status})`);
  }

  const counts = {
    invoices: await prisma.invoice.count(),
    lines: await prisma.invoiceLine.count(),
    files: await prisma.invoiceFile.count(),
  };

  console.log(`[Fixtures] Terminé — ${counts.invoices} factures, ${counts.lines} lignes, ${counts.files} fichiers en base.`);
}

main()
  .catch((err: unknown) => {
    console.error('[Fixtures] ERREUR :', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
