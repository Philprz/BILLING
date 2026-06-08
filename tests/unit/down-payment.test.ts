/**
 * Tests unitaires — résolution de l'acompte F3 (down-payment.service).
 *
 * Couvre :
 *   - isFinalInvoiceWithDownPayment : détection INVOICE + prepaidAmount > 0.
 *   - resolveDownPaymentDraw : rapprochement de l'acompte 386 (POSTED, sapDocEntry)
 *     via la clé BT-25 (correctedInvoiceRef) + supplierPaIdentifier ; motifs de blocage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pa-sap-bridge/database', () => {
  const invoice = { findFirst: vi.fn() };
  return { prisma: { invoice } };
});

import { prisma } from '@pa-sap-bridge/database';
import {
  isFinalInvoiceWithDownPayment,
  resolveDownPaymentDraw,
  isAdvanceCreditNote,
  resolveAdvanceForCreditNote,
} from '../../apps/api/src/services/down-payment.service';

const db = prisma as unknown as { invoice: { findFirst: ReturnType<typeof vi.fn> } };

afterEach(() => {
  vi.clearAllMocks();
});

describe('isFinalInvoiceWithDownPayment', () => {
  it('detects an INVOICE carrying a positive prepaidAmount', () => {
    expect(isFinalInvoiceWithDownPayment({ direction: 'INVOICE', prepaidAmount: 30 })).toBe(true);
  });

  it('ignores INVOICE without prepaidAmount', () => {
    expect(isFinalInvoiceWithDownPayment({ direction: 'INVOICE', prepaidAmount: null })).toBe(
      false,
    );
    expect(isFinalInvoiceWithDownPayment({ direction: 'INVOICE', prepaidAmount: 0 })).toBe(false);
  });

  it('ignores other directions even with a prepaidAmount', () => {
    expect(isFinalInvoiceWithDownPayment({ direction: 'ADVANCE_INVOICE', prepaidAmount: 30 })).toBe(
      false,
    );
    expect(isFinalInvoiceWithDownPayment({ direction: 'CREDIT_NOTE', prepaidAmount: 30 })).toBe(
      false,
    );
  });
});

describe('resolveDownPaymentDraw', () => {
  const base = {
    direction: 'INVOICE',
    prepaidAmount: 30,
    correctedInvoiceRef: 'ACPT-001',
    supplierPaIdentifier: 'FR123',
  };

  it('resolves the matching POSTED advance and returns its DocEntry + amountToDraw', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 120,
      status: 'POSTED',
    });

    const draw = await resolveDownPaymentDraw(base);

    expect(draw).toEqual({ ok: true, docEntry: 4242, amountToDraw: 30 });
    expect(db.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: 'ADVANCE_INVOICE',
          supplierPaIdentifier: 'FR123',
          docNumberPa: 'ACPT-001',
          status: 'POSTED',
        }),
      }),
    );
  });

  it('blocks when prepaidAmount is absent or null', async () => {
    const draw = await resolveDownPaymentDraw({ ...base, prepaidAmount: null });
    expect(draw.ok).toBe(false);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('blocks when correctedInvoiceRef (BT-25) is missing', async () => {
    const draw = await resolveDownPaymentDraw({ ...base, correctedInvoiceRef: null });
    expect(draw.ok).toBe(false);
    if (!draw.ok) expect(draw.reason).toMatch(/BT-25/);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('blocks when no POSTED advance is found', async () => {
    db.invoice.findFirst.mockResolvedValue(null);
    const draw = await resolveDownPaymentDraw(base);
    expect(draw.ok).toBe(false);
    if (!draw.ok) expect(draw.reason).toMatch(/introuvable/i);
  });

  it('blocks when the advance has no sapDocEntry', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: null,
      totalInclTax: 120,
      status: 'POSTED',
    });
    const draw = await resolveDownPaymentDraw(base);
    expect(draw.ok).toBe(false);
    if (!draw.ok) expect(draw.reason).toMatch(/DocEntry/);
  });

  it('blocks when the amount to draw exceeds the advance total', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 20,
      status: 'POSTED',
    });
    const draw = await resolveDownPaymentDraw({ ...base, prepaidAmount: 30 });
    expect(draw.ok).toBe(false);
    if (!draw.ok) expect(draw.reason).toMatch(/incohérent/i);
  });
});

describe('isAdvanceCreditNote', () => {
  it('detects an ADVANCE_CREDIT_NOTE (503)', () => {
    expect(isAdvanceCreditNote({ direction: 'ADVANCE_CREDIT_NOTE' })).toBe(true);
  });

  it('ignores other directions', () => {
    expect(isAdvanceCreditNote({ direction: 'CREDIT_NOTE' })).toBe(false);
    expect(isAdvanceCreditNote({ direction: 'INVOICE' })).toBe(false);
    expect(isAdvanceCreditNote({ direction: 'ADVANCE_INVOICE' })).toBe(false);
  });
});

describe('resolveAdvanceForCreditNote', () => {
  const base = {
    direction: 'ADVANCE_CREDIT_NOTE',
    totalInclTax: 50,
    correctedInvoiceRef: 'ACPT-001',
    supplierPaIdentifier: 'FR123',
  };

  it('resolves the advance and returns DocEntry + invoiceId + amount (partial allowed)', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 120,
      status: 'POSTED',
    });

    const rev = await resolveAdvanceForCreditNote(base);

    expect(rev).toEqual({
      ok: true,
      advanceDocEntry: 4242,
      advanceInvoiceId: 'adv-1',
      amount: 50,
    });
    expect(db.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: 'ADVANCE_INVOICE',
          supplierPaIdentifier: 'FR123',
          docNumberPa: 'ACPT-001',
          status: 'POSTED',
        }),
      }),
    );
  });

  it('treats the amount in absolute value (negative-stored credit note)', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 120,
      status: 'POSTED',
    });
    const rev = await resolveAdvanceForCreditNote({ ...base, totalInclTax: -50 });
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.amount).toBe(50);
  });

  it('allows a total reversal equal to the advance amount', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 120,
      status: 'POSTED',
    });
    const rev = await resolveAdvanceForCreditNote({ ...base, totalInclTax: 120 });
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.amount).toBe(120);
  });

  it('blocks when the 503 amount is zero', async () => {
    const rev = await resolveAdvanceForCreditNote({ ...base, totalInclTax: 0 });
    expect(rev.ok).toBe(false);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('blocks when correctedInvoiceRef (BT-25) is missing', async () => {
    const rev = await resolveAdvanceForCreditNote({ ...base, correctedInvoiceRef: null });
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toMatch(/BT-25/);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('blocks when no POSTED advance is found', async () => {
    db.invoice.findFirst.mockResolvedValue(null);
    const rev = await resolveAdvanceForCreditNote(base);
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toMatch(/introuvable/i);
  });

  it('blocks when the advance has no sapDocEntry', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: null,
      totalInclTax: 120,
      status: 'POSTED',
    });
    const rev = await resolveAdvanceForCreditNote(base);
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toMatch(/DocEntry/);
  });

  it('blocks when the reversal amount exceeds the original advance', async () => {
    db.invoice.findFirst.mockResolvedValue({
      id: 'adv-1',
      sapDocEntry: 4242,
      totalInclTax: 40,
      status: 'POSTED',
    });
    const rev = await resolveAdvanceForCreditNote({ ...base, totalInclTax: 50 });
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toMatch(/incohérent/i);
  });
});
