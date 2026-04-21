import { describe, expect, it } from 'vitest';
import { Prisma } from '@pa-sap-bridge/database';
import {
  buildJournalEntryPayload,
  buildPurchaseDocPayload,
  type InvoiceData,
  type LineData,
} from '../../apps/api/src/services/sap-invoice-builder';

function dec(value: number): Prisma.Decimal {
  return value as unknown as Prisma.Decimal;
}

const invoice: InvoiceData = {
  docNumberPa: 'DOC-TEST',
  direction: 'INVOICE',
  supplierB1Cardcode: 'F_TEST',
  docDate: new Date('2026-04-21T00:00:00.000Z'),
  dueDate: new Date('2026-05-21T00:00:00.000Z'),
  currency: 'EUR',
  supplierNameRaw: 'Supplier Test',
};

const lineWithAccount: LineData = {
  lineNo: 1,
  description: 'Licence logiciel annuelle',
  quantity: dec(1),
  unitPrice: dec(100),
  amountExclTax: dec(100),
  taxRate: dec(20),
  taxAmount: dec(20),
  amountInclTax: dec(120),
  chosenAccountCode: null,
  suggestedAccountCode: '601000',
  chosenTaxCodeB1: null,
  suggestedTaxCodeB1: null,
};

const lineWithoutAccount: LineData = {
  ...lineWithAccount,
  lineNo: 2,
  chosenAccountCode: null,
  suggestedAccountCode: null,
};

describe('sap-invoice-builder', () => {
  it('builds a purchase payload and skips lines without account code', () => {
    const result = buildPurchaseDocPayload(
      invoice,
      [lineWithAccount, lineWithoutAccount],
      789,
      { '20.00': 'S1' },
    );

    const payload = result.payload as { DocumentLines: Array<Record<string, unknown>>; AttachmentEntry: number };

    expect(result.skippedLines).toEqual([2]);
    expect(payload.AttachmentEntry).toBe(789);
    expect(payload.DocumentLines).toHaveLength(1);
    expect(payload.DocumentLines[0]).toMatchObject({
      AccountCode: '601000',
      TaxCode: 'S1',
    });
  });

  it('builds a balanced journal entry payload', () => {
    const result = buildJournalEntryPayload(
      invoice,
      [lineWithAccount],
      321,
      { '20.00': 'S1' },
      '40100000',
    );

    const payload = result.payload as { JournalEntries_Lines: Array<Record<string, unknown>>; AttachmentEntry: number };

    expect(result.skippedLines).toEqual([]);
    expect(payload.AttachmentEntry).toBe(321);
    expect(payload.JournalEntries_Lines).toHaveLength(2);
    expect(payload.JournalEntries_Lines[0]).toMatchObject({
      AccountCode: '601000',
      Debit: 100,
      Credit: 0,
      TaxCode: 'S1',
    });
    expect(payload.JournalEntries_Lines[1]).toMatchObject({
      AccountCode: '40100000',
      Debit: 0,
      Credit: 120,
    });
  });
});
