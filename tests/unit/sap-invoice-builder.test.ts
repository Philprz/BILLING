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
  chosenAccountCode: '601000',
  suggestedAccountCode: null,
  chosenTaxCodeB1: 'S1',
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
    const result = buildPurchaseDocPayload(invoice, [lineWithAccount, lineWithoutAccount], 789, {
      '20.00': 'S1',
    });

    const payload = result.payload as {
      DocumentLines: Array<Record<string, unknown>>;
      AttachmentEntry: number;
    };

    expect(result.skippedLines).toEqual([2]);
    expect(payload.AttachmentEntry).toBe(789);
    expect(payload.DocumentLines).toHaveLength(1);
    expect(payload.DocumentLines[0]).toMatchObject({
      AccountCode: '601000',
      TaxCode: 'S1',
    });
  });

  it('adds DownPaymentsToDraw when a draw is provided (F3)', () => {
    const result = buildPurchaseDocPayload(
      invoice,
      [lineWithAccount],
      0,
      { '20.00': 'S1' },
      {
        docEntry: 4242,
        amountToDraw: 30,
      },
    );

    const payload = result.payload as {
      DownPaymentsToDraw?: Array<{ DocEntry: number; AmountToDraw: number }>;
    };

    expect(payload.DownPaymentsToDraw).toEqual([{ DocEntry: 4242, AmountToDraw: 30 }]);
  });

  it('adds DownPaymentsToDraw on an advance credit note (503 contre-passation, partial)', () => {
    // Même paramètre downPaymentDraw que F3 ; la route poste ce payload vers
    // PurchaseCreditNotes. Le builder est agnostique du docType.
    const result = buildPurchaseDocPayload(
      { ...invoice, direction: 'ADVANCE_CREDIT_NOTE' },
      [lineWithAccount],
      0,
      { '20.00': 'S1' },
      { docEntry: 4242, amountToDraw: 50 },
    );

    const payload = result.payload as {
      DownPaymentsToDraw?: Array<{ DocEntry: number; AmountToDraw: number }>;
    };

    expect(payload.DownPaymentsToDraw).toEqual([{ DocEntry: 4242, AmountToDraw: 50 }]);
  });

  it('does not add DownPaymentsToDraw for a normal invoice (no draw)', () => {
    const result = buildPurchaseDocPayload(invoice, [lineWithAccount], 0, { '20.00': 'S1' });

    const payload = result.payload as { DownPaymentsToDraw?: unknown };

    expect(payload.DownPaymentsToDraw).toBeUndefined();
  });

  it('sets DownPaymentType=dptInvoice for a down payment (386, PurchaseDownPayments)', () => {
    const result = buildPurchaseDocPayload(
      { ...invoice, direction: 'ADVANCE_INVOICE' },
      [lineWithAccount],
      0,
      { '20.00': 'S1' },
      undefined, // pas de tirage : le 386 EST l'acompte
      true, // isDownPayment
    );

    const payload = result.payload as {
      DownPaymentType?: string;
      DocType?: string;
      DocumentLines: Array<Record<string, unknown>>;
      DownPaymentsToDraw?: unknown;
    };

    // Seul écart vs PurchaseInvoices : DownPaymentType. Lignes/DocType inchangés.
    expect(payload.DownPaymentType).toBe('dptInvoice');
    expect(payload.DocType).toBe('dDocument_Service');
    expect(payload.DownPaymentsToDraw).toBeUndefined();
    expect(payload.DocumentLines[0]).toMatchObject({ AccountCode: '601000', TaxCode: 'S1' });
  });

  it('does not set DownPaymentType for a normal invoice (PurchaseInvoices)', () => {
    const result = buildPurchaseDocPayload(invoice, [lineWithAccount], 0, { '20.00': 'S1' });

    const payload = result.payload as { DownPaymentType?: string };

    expect(payload.DownPaymentType).toBeUndefined();
  });

  it('builds a balanced journal entry payload', () => {
    const result = buildJournalEntryPayload(invoice, [lineWithAccount], 321, { '20.00': 'S1' });

    const payload = result.payload as {
      JournalEntryLines: Array<Record<string, unknown>>;
      AttachmentEntry: number;
    };

    expect(result.skippedLines).toEqual([]);
    expect(payload.AttachmentEntry).toBe(321);
    expect(payload.JournalEntryLines).toHaveLength(2);
    expect(payload.JournalEntryLines[0]).toMatchObject({
      AccountCode: '601000',
      Debit: 100,
      Credit: 0,
      TaxCode: 'S1',
    });
    expect(payload.JournalEntryLines[1]).toMatchObject({
      ShortName: 'F_TEST',
      Debit: 0,
      Credit: 120,
    });
  });
});
