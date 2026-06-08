/**
 * Tests unitaires — Partie A : paiement sortant + lettrage (sap-payment.service).
 *
 * Couvre :
 *   - resolveSupplierPaymentMeans : moyen lu du BP → payload ; BP sans moyen / banque
 *     absente / compte non configuré / moyen non automatisé → BLOCAGE (jamais de compte inventé).
 *   - buildOutgoingPaymentPayload : lettrage PaymentInvoices qui solde le poste.
 *   - preparePayment : idempotence (déjà payée), poste non ouvert, direction non payable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Lectures SAP mockées ; la logique pure (means + builder) reste réelle.
vi.mock('../../apps/api/src/services/sap-sl.service', () => ({
  fetchSupplierPaymentConfig: vi.fn(),
  fetchPaymentMethod: vi.fn(),
  fetchPurchaseInvoiceSettlement: vi.fn(),
}));

import {
  fetchSupplierPaymentConfig,
  fetchPaymentMethod,
  fetchPurchaseInvoiceSettlement,
} from '../../apps/api/src/services/sap-sl.service';
import {
  resolveSupplierPaymentMeans,
  buildOutgoingPaymentPayload,
  preparePayment,
} from '../../apps/api/src/services/sap-payment.service';

const bpConfig = vi.mocked(fetchSupplierPaymentConfig);
const method = vi.mocked(fetchPaymentMethod);
const settlement = vi.mocked(fetchPurchaseInvoiceSettlement);

const TRANSFER_ACCOUNTS = { transferAccount: '512000', cashAccount: '530000' };

afterEach(() => vi.clearAllMocks());

describe('resolveSupplierPaymentMeans', () => {
  const bpTransfer = {
    cardCode: 'F00001',
    paymentMethodCode: 'Virement fourn',
    defaultBankCode: '-1',
    houseBank: '30003',
    houseBankAccount: '00267182913',
    houseBankIban: 'FR76...',
  };
  const transferMethod = {
    paymentMethodCode: 'Virement fourn',
    type: 'boptOutgoing',
    paymentMeans: 'bopmBankTransfer',
  };

  it('virement : moyen lu du BP → résolu sur le compte de décaissement configuré', () => {
    const r = resolveSupplierPaymentMeans(bpTransfer, transferMethod, TRANSFER_ACCOUNTS);
    expect(r).toEqual({
      ok: true,
      means: 'TRANSFER',
      account: '512000',
      methodCode: 'Virement fourn',
    });
  });

  it('BLOQUE si le BP n’a pas de moyen de paiement', () => {
    const r = resolveSupplierPaymentMeans(
      { ...bpTransfer, paymentMethodCode: null },
      null,
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non configuré/i);
  });

  it('BLOQUE le virement si le fournisseur n’a pas de banque par défaut', () => {
    const r = resolveSupplierPaymentMeans(
      { ...bpTransfer, houseBank: null },
      transferMethod,
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/banque par défaut/i);
  });

  it('BLOQUE si le compte de décaissement n’est pas configuré (jamais inventé)', () => {
    const r = resolveSupplierPaymentMeans(bpTransfer, transferMethod, {
      transferAccount: null,
      cashAccount: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SAP_PAYMENT_TRANSFER_ACCOUNT/);
  });

  it('BLOQUE un moyen non automatisé (chèque)', () => {
    const r = resolveSupplierPaymentMeans(
      bpTransfer,
      { ...transferMethod, paymentMeans: 'bopmCheck' },
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non automatisé|manuel/i);
  });

  it('BLOQUE une méthode non sortante (boptIncoming)', () => {
    const r = resolveSupplierPaymentMeans(
      bpTransfer,
      { ...transferMethod, type: 'boptIncoming' },
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non sortante/i);
  });
});

describe('buildOutgoingPaymentPayload', () => {
  it('construit un paiement virement avec lettrage qui solde le poste', () => {
    const payload = buildOutgoingPaymentPayload({
      cardCode: 'F00001',
      docDate: '2026-06-05',
      docCurrency: 'EUR',
      docRate: 1,
      means: { means: 'TRANSFER', account: '512000' },
      openAmount: 1200.5,
      invoiceDocEntry: 433,
      invoiceType: 'it_PurchaseInvoice',
    });
    expect(payload).toMatchObject({
      DocObjectCode: 'bopot_OutgoingPayments',
      DocType: 'rSupplier',
      CardCode: 'F00001',
      TransferAccount: '512000',
      TransferSum: 1200.5,
      TransferDate: '2026-06-05',
      DocCurrency: 'EUR',
    });
    expect(payload.PaymentInvoices).toEqual([
      { DocEntry: 433, InvoiceType: 'it_PurchaseInvoice', SumApplied: 1200.5 },
    ]);
  });
});

describe('preparePayment — validations bloquantes', () => {
  const integrated = {
    id: 'inv-1',
    direction: 'INVOICE',
    status: 'POSTED',
    supplierB1Cardcode: 'F00001',
    sapDocEntry: 433,
    sapPaymentDocEntry: null,
  };

  it('BLOQUE (idempotence) si la facture est déjà payée', async () => {
    const r = await preparePayment(
      'COOKIE',
      { ...integrated, sapPaymentDocEntry: 99 },
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(409);
      expect(r.reason).toMatch(/déjà payée/i);
    }
    expect(settlement).not.toHaveBeenCalled();
  });

  it('BLOQUE une direction non payable (acompte)', async () => {
    const r = await preparePayment(
      'COOKIE',
      { ...integrated, direction: 'ADVANCE_INVOICE' },
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(409);
    expect(settlement).not.toHaveBeenCalled();
  });

  it('BLOQUE une facture non intégrée', async () => {
    const r = await preparePayment(
      'COOKIE',
      { ...integrated, status: 'READY', sapDocEntry: null },
      TRANSFER_ACCOUNTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(409);
  });

  it('BLOQUE si le poste est déjà soldé (montant ouvert = 0)', async () => {
    settlement.mockResolvedValue({
      docEntry: 433,
      docNum: 433,
      cardCode: 'F00001',
      docTotal: 1000,
      paidToDate: 1000,
      openAmount: 0,
      documentStatus: 'bost_Close',
      docCurrency: 'EUR',
      docRate: 1,
    });
    const r = await preparePayment('COOKIE', integrated, TRANSFER_ACCOUNTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(409);
      expect(r.reason).toMatch(/soldé|ouvert/i);
    }
  });

  it('construit le paiement (montant ouvert lu en direct) quand tout est valide', async () => {
    settlement.mockResolvedValue({
      docEntry: 433,
      docNum: 433,
      cardCode: 'F00001',
      docTotal: 1200.5,
      paidToDate: 0,
      openAmount: 1200.5,
      documentStatus: 'bost_Open',
      docCurrency: 'EUR',
      docRate: 1,
    });
    bpConfig.mockResolvedValue({
      cardCode: 'F00001',
      paymentMethodCode: 'Virement fourn',
      defaultBankCode: '-1',
      houseBank: '30003',
      houseBankAccount: '00267182913',
      houseBankIban: 'FR76...',
    });
    method.mockResolvedValue({
      paymentMethodCode: 'Virement fourn',
      type: 'boptOutgoing',
      paymentMeans: 'bopmBankTransfer',
    });

    const r = await preparePayment('COOKIE', integrated, TRANSFER_ACCOUNTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settlement.openAmount).toBe(1200.5);
      expect(r.means.means).toBe('TRANSFER');
      expect((r.payload.PaymentInvoices as unknown[])[0]).toEqual({
        DocEntry: 433,
        InvoiceType: 'it_PurchaseInvoice',
        SumApplied: 1200.5,
      });
      expect(r.payload.TransferSum).toBe(1200.5);
    }
  });

  it('BLOQUE (422) si le moyen du fournisseur n’est pas exploitable', async () => {
    settlement.mockResolvedValue({
      docEntry: 433,
      docNum: 433,
      cardCode: 'F00001',
      docTotal: 1200.5,
      paidToDate: 0,
      openAmount: 1200.5,
      documentStatus: 'bost_Open',
      docCurrency: 'EUR',
      docRate: 1,
    });
    bpConfig.mockResolvedValue({
      cardCode: 'F00001',
      paymentMethodCode: null,
      defaultBankCode: null,
      houseBank: null,
      houseBankAccount: null,
      houseBankIban: null,
    });
    method.mockResolvedValue(null);

    const r = await preparePayment('COOKIE', integrated, TRANSFER_ACCOUNTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(422);
  });
});
