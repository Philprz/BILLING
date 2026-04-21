import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { prisma } from '@pa-sap-bridge/database';

export interface TestInvoiceOptions {
  status?: 'NEW' | 'TO_REVIEW' | 'READY' | 'POSTED' | 'REJECTED' | 'ERROR';
  supplierB1Cardcode?: string | null;
  statusReason?: string | null;
  paSource?: string;
}

export async function createTestInvoice(options: TestInvoiceOptions = {}): Promise<string> {
  const status = options.status ?? 'READY';
  const suffix = randomUUID().slice(0, 8);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sap-bridge-test-'));
  const filePath = path.join(tempDir, `invoice_${suffix}.xml`);
  fs.writeFileSync(filePath, `<invoice id="${suffix}" />`, 'utf-8');

  const invoice = await prisma.invoice.create({
    data: {
      paMessageId: `TEST-${status}-${suffix}`,
      paSource: options.paSource ?? 'TEST_SUITE',
      direction: 'INVOICE',
      format: 'UBL',
      supplierPaIdentifier: `SIREN-${suffix}`,
      supplierNameRaw: `Supplier ${suffix}`,
      supplierB1Cardcode: options.supplierB1Cardcode ?? 'F_TEST',
      supplierMatchConfidence: 95,
      docNumberPa: `DOC-${suffix}`,
      docDate: new Date('2026-04-21'),
      dueDate: new Date('2026-05-21'),
      currency: 'EUR',
      totalExclTax: 100,
      totalTax: 20,
      totalInclTax: 120,
      status,
      statusReason: options.statusReason ?? (status === 'TO_REVIEW' ? 'Contrôle requis' : null),
      integrationMode: status === 'POSTED' ? 'SERVICE_INVOICE' : null,
      sapDocEntry: status === 'POSTED' ? 45000 : null,
      sapDocNum: status === 'POSTED' ? 46000 : null,
      lines: {
        create: [{
          lineNo: 1,
          description: `Line ${suffix}`,
          quantity: 1,
          unitPrice: 100,
          amountExclTax: 100,
          taxCode: 'TVA20',
          taxRate: 20,
          taxAmount: 20,
          amountInclTax: 120,
          suggestedAccountCode: '601000',
          suggestedAccountConfidence: 90,
          suggestedTaxCodeB1: 'S1',
          suggestionSource: 'Fixture de test',
        }],
      },
      files: {
        create: [{
          kind: 'XML',
          path: filePath,
          sizeBytes: BigInt(fs.statSync(filePath).size),
          sha256: `sha-${suffix}`,
        }],
      },
    },
  });

  return invoice.id;
}

export async function deleteInvoicesByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
  await prisma.invoice.deleteMany({ where: { id: { in: ids } } });
}
