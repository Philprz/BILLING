import { normalizeSapCookieHeader } from './sap-auth.service';

export class SapReferenceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'SapReferenceError';
    this.statusCode = statusCode;
  }
}

interface SapLookupOptions {
  resource: string;
  keyField: string;
  value: string;
}

interface SapReferenceCheckResult {
  missing: string[];
  checked: string[];
}

function ensureSapBaseUrl(): string {
  const baseUrl = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new SapReferenceError('SAP_REST_BASE_URL non configurée', 500);
  }
  return baseUrl;
}

function quoteODataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function sapEntityExists(
  sapSessionCookie: string,
  options: SapLookupOptions,
): Promise<boolean> {
  const baseUrl = ensureSapBaseUrl();
  const params = new URLSearchParams({
    $select: options.keyField,
    $filter: `${options.keyField} eq ${quoteODataString(options.value)}`,
    $top: '1',
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${options.resource}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Cookie: normalizeSapCookieHeader(sapSessionCookie),
        Prefer: 'odata.maxpagesize=1',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SapReferenceError(`Impossible de joindre SAP B1: ${message}`, 502);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new SapReferenceError(
      `Lecture SAP ${options.resource} impossible (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
      response.status >= 500 ? 502 : response.status,
    );
  }

  const body = (await response.json().catch(() => ({}))) as { value?: unknown[] };
  return Array.isArray(body.value) && body.value.length > 0;
}

async function checkCodes(
  sapSessionCookie: string,
  resource: string,
  keyField: string,
  values: string[],
): Promise<SapReferenceCheckResult> {
  const uniqueValues = [...new Set(values.filter((value) => value.trim().length > 0))];
  const missing: string[] = [];

  for (const value of uniqueValues) {
    const exists = await sapEntityExists(sapSessionCookie, { resource, keyField, value });
    if (!exists) missing.push(value);
  }

  return { missing, checked: uniqueValues };
}

export async function checkSupplierExists(
  sapSessionCookie: string,
  cardCode: string,
): Promise<boolean> {
  return sapEntityExists(sapSessionCookie, {
    resource: process.env.SAP_BP_RESOURCE ?? 'BusinessPartners',
    keyField: process.env.SAP_BP_KEY_FIELD ?? 'CardCode',
    value: cardCode,
  });
}

export async function checkAccountCodesExist(
  sapSessionCookie: string,
  accountCodes: string[],
): Promise<SapReferenceCheckResult> {
  return checkCodes(
    sapSessionCookie,
    process.env.SAP_GL_RESOURCE ?? 'ChartOfAccounts',
    process.env.SAP_GL_KEY_FIELD ?? 'Code',
    accountCodes,
  );
}

export async function checkTaxCodesExist(
  sapSessionCookie: string,
  taxCodes: string[],
): Promise<SapReferenceCheckResult> {
  return checkCodes(
    sapSessionCookie,
    process.env.SAP_TAX_RESOURCE ?? 'VatGroups',
    process.env.SAP_TAX_KEY_FIELD ?? 'Code',
    taxCodes,
  );
}

export async function checkCostCentersExist(
  sapSessionCookie: string,
  costCenters: string[],
): Promise<SapReferenceCheckResult> {
  return checkCodes(
    sapSessionCookie,
    process.env.SAP_COST_CENTER_RESOURCE ?? 'ProfitCenters',
    process.env.SAP_COST_CENTER_KEY_FIELD ?? 'CenterCode',
    costCenters,
  );
}
