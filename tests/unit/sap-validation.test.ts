import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@pa-sap-bridge/database';
import type { LineData } from '../../apps/api/src/services/sap-invoice-builder';

const accountCache = new Map<
  string,
  {
    acctCode: string;
    acctName: string;
    activeAccount: boolean;
    postable: boolean;
    accountLevel: number | null;
    groupMask: number | null;
  }
>();

vi.mock('../../apps/api/src/services/chart-of-accounts-cache.service', () => ({
  getCachedAccountsByCode: vi.fn(async (codes: string[]) => {
    const result = new Map();
    for (const code of codes) {
      const account = accountCache.get(code);
      if (account) result.set(code, account);
    }
    return result;
  }),
}));

const { validateInvoiceForSapPost } =
  await import('../../apps/api/src/services/sap-validation.service');

function dec(value: number): Prisma.Decimal {
  return value as unknown as Prisma.Decimal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const validLine: LineData = {
  lineNo: 1,
  description: 'Licence annuelle',
  quantity: dec(1),
  unitPrice: dec(100),
  amountExclTax: dec(100),
  taxRate: dec(20),
  taxAmount: dec(20),
  amountInclTax: dec(120),
  chosenAccountCode: '601000',
  suggestedAccountCode: null,
  chosenCostCenter: null,
  suggestedCostCenter: null,
  chosenTaxCodeB1: 'S1',
  suggestedTaxCodeB1: null,
};

// ─── Helpers mocks SAP ────────────────────────────────────────────────────────

/** BP existant avec SIRET dans TaxId0 et TVA dans FederalTaxID */
const bpWithSiretAndVat = {
  CardCode: 'F_TEST',
  FederalTaxID: 'FR12345678901',
  VATRegistrationNumber: null,
  TaxId0: '41258736900019',
  TaxId1: null,
  TaxId2: null,
};

/** BP existant avec SIREN (9 chiffres) dans TaxId0, sans TVA */
const bpWithSirenNoVat = {
  CardCode: 'F_TEST',
  FederalTaxID: null,
  VATRegistrationNumber: null,
  TaxId0: '412587369',
  TaxId1: null,
  TaxId2: null,
};

/** BP sans aucun identifiant légal ni TVA */
const bpEmpty = {
  CardCode: 'F_TEST',
  FederalTaxID: null,
  VATRegistrationNumber: null,
  TaxId0: null,
  TaxId1: null,
  TaxId2: null,
};

/** BP avec FederalTaxID de type TVA (FR...) mais sans SIRET/SIREN dans TaxId* */
const bpVatOnlyNoSiret = {
  CardCode: 'F_TEST',
  FederalTaxID: 'FR12345678901',
  VATRegistrationNumber: null,
  TaxId0: null,
  TaxId1: null,
  TaxId2: null,
};

/** BP avec SIRET présent (TaxId0) mais sans FederalTaxID */
const bpSiretNoFederalTaxId = {
  CardCode: 'F_TEST',
  FederalTaxID: null,
  VATRegistrationNumber: null,
  TaxId0: '41258736900019',
  TaxId1: null,
  TaxId2: null,
};

/**
 * Construit un fetchSpy SAP qui discrimine les appels :
 *   - checkSupplierExists  → $select=CardCode  → { value: [{}] } si supplierExists, sinon { value: [] }
 *   - fetchSupplierFiscalFields → $select=CardCode,FederalTaxID,... → bpRecord ou { value: [] }
 *   - checkTaxCodesExist   → VatGroups → { value: [{}] } si taxExists
 *   - checkCostCentersExist → ProfitCenters → { value: [{}] } si costCenterExists
 */
function makeFetchSpy(options: {
  supplierExists?: boolean;
  bpRecord?: Record<string, unknown> | null; // null = BP not found for fiscal query
  taxExists?: boolean;
  costCenterExists?: boolean;
}): ReturnType<typeof vi.fn> {
  const {
    supplierExists = true,
    bpRecord = bpWithSiretAndVat,
    taxExists = true,
    costCenterExists = true,
  } = options;

  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('BusinessPartners')) {
      if (href.includes('FederalTaxID')) {
        // fetchSupplierFiscalFields
        if (bpRecord === null) return jsonResponse({ value: [] });
        return jsonResponse({ value: [bpRecord] });
      }
      // checkSupplierExists
      return jsonResponse({ value: supplierExists ? [{}] : [] });
    }
    if (href.includes('VatGroups')) return jsonResponse({ value: taxExists ? [{}] : [] });
    if (href.includes('ProfitCenters'))
      return jsonResponse({ value: costCenterExists ? [{}] : [] });
    return jsonResponse({ value: [{}] });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sap-validation.service', () => {
  const previousBaseUrl = process.env.SAP_REST_BASE_URL;

  afterEach(() => {
    accountCache.clear();
    if (previousBaseUrl === undefined) delete process.env.SAP_REST_BASE_URL;
    else process.env.SAP_REST_BASE_URL = previousBaseUrl;
    vi.restoreAllMocks();
  });

  it('fails fast on local blocking issues without calling SAP', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const report = await validateInvoiceForSapPost(
      {
        status: 'POSTED',
        supplierB1Cardcode: null,
        files: [],
        lines: [{ ...validLine, chosenAccountCode: null, suggestedAccountCode: null }],
      },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual([
      'INVALID_STATUS',
      'MISSING_ATTACHMENT',
      'MISSING_SUPPLIER',
      'MISSING_ACCOUNT_CODE',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── Identifiant légal (SIRET/SIREN) ────────────────────────────────────────

  it('passes when BP has SIRET (14 digits) in TaxId0 and VAT in FederalTaxID', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpWithSiretAndVat }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('blocks when BP has SIREN (9 digits) but no VAT identifier', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpWithSirenNoVat }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    // SIREN présent → identifiant légal OK ; TVA absente → bloquant (SAP rejette)
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'MISSING_LEGAL_IDENTIFIER')).toBe(false);
    expect(report.issues.some((i) => i.code === 'MISSING_VAT_IDENTIFIER')).toBe(true);
    expect(report.issues.find((i) => i.code === 'MISSING_VAT_IDENTIFIER')?.severity).toBe(
      'WARNING',
    );
  });

  it('blocks when BP has no SIRET/SIREN anywhere', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpEmpty }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_LEGAL_IDENTIFIER');
    expect(codes).toContain('MISSING_VAT_IDENTIFIER');
  });

  it('blocks when BP has FederalTaxID of type FR... (VAT) but no SIRET/SIREN in TaxId fields', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpVatOnlyNoSiret }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    // FederalTaxID = FR... → found as VAT but NOT as SIRET/SIREN (EU_VAT pattern ≠ 9/14 digits)
    expect(report.issues.some((i) => i.code === 'MISSING_LEGAL_IDENTIFIER')).toBe(true);
    expect(report.issues.some((i) => i.code === 'MISSING_VAT_IDENTIFIER')).toBe(false);
  });

  it('blocks when BP has SIRET in TaxId0 but FederalTaxID (TVA) is absent', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpSiretNoFederalTaxId }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    // SIRET présent → identifiant légal OK ; FederalTaxID absent → bloquant (SAP rejette sans TVA)
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'MISSING_LEGAL_IDENTIFIER')).toBe(false);
    expect(report.issues.some((i) => i.code === 'MISSING_VAT_IDENTIFIER')).toBe(true);
  });

  it('error message for MISSING_LEGAL_IDENTIFIER does not mention FederalTaxID', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpEmpty }));

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    const legalIssue = report.issues.find((i) => i.code === 'MISSING_LEGAL_IDENTIFIER');
    expect(legalIssue).toBeDefined();
    expect(legalIssue!.message.toLowerCase()).not.toContain('federaltaxid');
    expect(legalIssue!.message).toContain('SIRET');
    expect(legalIssue!.message).toContain('SIREN');
  });

  // ─── Cas couverts avant (non-régressions) ────────────────────────────────────

  it('passes when SAP and cached account references exist', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpWithSiretAndVat }));

    const report = await validateInvoiceForSapPost(
      {
        status: 'READY',
        supplierB1Cardcode: 'F_TEST',
        files: [{ id: 'file-1' }],
        lines: [validLine],
      },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checkedRefs.accountCodes).toEqual(['601000']);
    expect(report.checkedRefs.taxCodes).toEqual(['S1']);
  });

  it('reports missing SAP and cached account references', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    vi.stubGlobal(
      'fetch',
      makeFetchSpy({ supplierExists: false, bpRecord: null, taxExists: false }),
    );

    const report = await validateInvoiceForSapPost(
      {
        status: 'READY',
        supplierB1Cardcode: 'F_UNKNOWN',
        files: [{ id: 'file-1' }],
        lines: [validLine],
      },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('INVALID_ACCOUNT_CODE');
    expect(codes).toContain('INVALID_SUPPLIER');
    expect(codes).toContain('INVALID_TAX_CODE');
    // supplierExists = false → INVALID_SUPPLIER, pas de contrôle fiscal
    expect(codes).not.toContain('MISSING_LEGAL_IDENTIFIER');
  });

  it('blocks non-postable cached accounts', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Titre non imputable',
      activeAccount: true,
      postable: false,
      accountLevel: 3,
      groupMask: 6,
    });
    vi.stubGlobal('fetch', makeFetchSpy({ bpRecord: bpWithSiretAndVat }));

    const report = await validateInvoiceForSapPost(
      {
        status: 'READY',
        supplierB1Cardcode: 'F_TEST',
        files: [{ id: 'file-1' }],
        lines: [validLine],
      },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'INVALID_ACCOUNT_CODE')).toBe(true);
  });

  it('does not block when SAP is unreachable for fiscal check (undefined returned)', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    accountCache.set('601000', {
      acctCode: '601000',
      acctName: 'Charges',
      activeAccount: true,
      postable: true,
      accountLevel: 5,
      groupMask: 6,
    });

    // SAP répond OK pour checkSupplierExists + checkTaxCodes, mais throw réseau sur fetchSupplierFiscalFields
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes('FederalTaxID')) {
          callCount++;
          throw new Error('network error');
        }
        return jsonResponse({ value: [{}] });
      }),
    );

    const report = await validateInvoiceForSapPost(
      { status: 'READY', supplierB1Cardcode: 'F_TEST', files: [{ id: 'f1' }], lines: [validLine] },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    // SAP injoignable pour le check fiscal → on ne bloque pas
    expect(callCount).toBe(1);
    expect(report.issues.some((i) => i.code === 'MISSING_LEGAL_IDENTIFIER')).toBe(false);
    expect(report.issues.some((i) => i.code === 'MISSING_VAT_IDENTIFIER')).toBe(false);
  });
});

// ─── Tests unitaires des helpers fiscaux ─────────────────────────────────────

import {
  getSupplierLegalIdentifier,
  getSupplierVatIdentifier,
} from '../../apps/api/src/services/sap-reference.service';

describe('getSupplierLegalIdentifier', () => {
  it('returns SIRET from TaxId0 (14 digits)', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: '41258736900019',
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBe('41258736900019');
  });

  it('returns SIREN from TaxId0 (9 digits)', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: '412587369',
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBe('412587369');
  });

  it('prefers SIRET over SIREN when both present in different fields', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: '412587369',
        TaxId1: '41258736900019',
        TaxId2: null,
      }),
    ).toBe('41258736900019');
  });

  it('does not match EU VAT (FR...) as SIRET/SIREN', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: 'FR12345678901',
        VATRegistrationNumber: null,
        TaxId0: null,
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBeNull();
  });

  it('returns null when all fields are empty', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: null,
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBeNull();
  });

  it('ignores whitespace-only values', () => {
    expect(
      getSupplierLegalIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: '   ',
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBeNull();
  });
});

describe('getSupplierVatIdentifier', () => {
  it('returns FR VAT from FederalTaxID', () => {
    expect(
      getSupplierVatIdentifier({
        FederalTaxID: 'FR12345678901',
        VATRegistrationNumber: null,
        TaxId0: null,
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBe('FR12345678901');
  });

  it('returns EU VAT from VATRegistrationNumber if FederalTaxID absent', () => {
    expect(
      getSupplierVatIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: 'DE123456789',
        TaxId0: null,
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBe('DE123456789');
  });

  it('does not match SIRET (14 digits) as VAT', () => {
    expect(
      getSupplierVatIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: '41258736900019',
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBeNull();
  });

  it('returns null when no EU VAT present', () => {
    expect(
      getSupplierVatIdentifier({
        FederalTaxID: null,
        VATRegistrationNumber: null,
        TaxId0: null,
        TaxId1: null,
        TaxId2: null,
      }),
    ).toBeNull();
  });
});
