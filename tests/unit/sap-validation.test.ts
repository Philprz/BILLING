import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@pa-sap-bridge/database';
import { validateInvoiceForSapPost } from '../../apps/api/src/services/sap-validation.service';
import type { LineData } from '../../apps/api/src/services/sap-invoice-builder';

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

describe('sap-validation.service', () => {
  const previousBaseUrl = process.env.SAP_REST_BASE_URL;

  afterEach(() => {
    if (previousBaseUrl === undefined) delete process.env.SAP_REST_BASE_URL;
    else process.env.SAP_REST_BASE_URL = previousBaseUrl;
    vi.restoreAllMocks();
  });

  it('fails fast on local blocking issues without calling SAP', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const report = await validateInvoiceForSapPost(
      {
        status: 'TO_REVIEW',
        supplierB1Cardcode: null,
        files: [],
        lines: [{ ...validLine, chosenAccountCode: null, suggestedAccountCode: null }],
      },
      'SERVICE_INVOICE',
      'B1',
      { '20.00': 'S1' },
    );

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'INVALID_STATUS',
      'MISSING_ATTACHMENT',
      'MISSING_SUPPLIER',
      'MISSING_ACCOUNT_CODE',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes when live SAP references exist', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    const fetchSpy = vi.fn(async () => jsonResponse({ value: [{}] }));
    vi.stubGlobal('fetch', fetchSpy);

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
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reports missing live SAP references', async () => {
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    const fetchSpy = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('BusinessPartners')) return jsonResponse({ value: [] });
      if (href.includes('ChartOfAccounts')) return jsonResponse({ value: [] });
      if (href.includes('SalesTaxCodes')) return jsonResponse({ value: [] });
      return jsonResponse({ value: [] });
    });
    vi.stubGlobal('fetch', fetchSpy);

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
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'INVALID_SUPPLIER',
      'INVALID_ACCOUNT_CODE',
      'INVALID_TAX_CODE',
    ]);
  });
});
