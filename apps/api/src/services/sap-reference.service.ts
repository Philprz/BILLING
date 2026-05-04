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

async function sapChartAccountExists(
  sapSessionCookie: string,
  accountCode: string,
): Promise<boolean> {
  const baseUrl = ensureSapBaseUrl();
  const quoted = quoteODataString(accountCode);
  const params = new URLSearchParams({
    $select: 'Code,FormatCode',
    $filter: `ActiveAccount eq 'tYES' and (Code eq ${quoted} or FormatCode eq ${quoted})`,
    $top: '1',
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/ChartOfAccounts?${params.toString()}`, {
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
      `Lecture SAP ChartOfAccounts impossible (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
      response.status >= 500 ? 502 : response.status,
    );
  }

  const body = (await response.json().catch(() => ({}))) as { value?: unknown[] };
  return Array.isArray(body.value) && body.value.length > 0;
}

async function checkChartAccountCodes(
  sapSessionCookie: string,
  accountCodes: string[],
): Promise<SapReferenceCheckResult> {
  const uniqueValues = [...new Set(accountCodes.filter((value) => value.trim().length > 0))];
  const missing: string[] = [];

  for (const value of uniqueValues) {
    const exists = await sapChartAccountExists(sapSessionCookie, value);
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
  const resource = process.env.SAP_GL_RESOURCE ?? 'ChartOfAccounts';
  const keyField = process.env.SAP_GL_KEY_FIELD ?? 'Code';
  if (resource === 'ChartOfAccounts' && keyField === 'Code') {
    return checkChartAccountCodes(sapSessionCookie, accountCodes);
  }

  return checkCodes(sapSessionCookie, resource, keyField, accountCodes);
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

// ─── Identifiants fiscaux fournisseur ────────────────────────────────────────
//
// En localisation FR, SAP B1 expose plusieurs champs fiscaux sur BusinessPartners :
//   FederalTaxID          → identifiant TVA intracommunautaire (FR + clé + SIREN, ex: FR12345678901)
//   VATRegistrationNumber → numéro TVA UE (souvent identique à FederalTaxID en FR)
//   TaxId0 / TaxId1 / TaxId2 → identifiants complémentaires selon localisation ;
//                              en FR, TaxId0 correspond généralement au champ UI
//                              "N° identification entreprise" = SIRET (14 chiffres)
//
// Ne pas confondre SIRET/SIREN (identifiant légal, purement numérique) avec
// le numéro de TVA intracommunautaire (alphanumérique, commence par code pays).

export interface BpFiscalFields {
  FederalTaxID: string | null;
  VATRegistrationNumber: string | null;
  TaxId0: string | null;
  TaxId1: string | null;
  TaxId2: string | null;
}

const SIRET_RE = /^\d{14}$/;
const SIREN_RE = /^\d{9}$/;
const EU_VAT_RE = /^[A-Z]{2}/i;

function normalizeField(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

/**
 * Retourne l'identifiant légal du fournisseur (SIRET 14 chiffres ou SIREN 9 chiffres)
 * en inspectant tous les champs fiscaux du BP dans l'ordre de priorité.
 * En localisation FR, TaxId0 = "N° identification entreprise" = SIRET.
 */
export function getSupplierLegalIdentifier(bp: BpFiscalFields): string | null {
  const candidates = [bp.TaxId0, bp.TaxId1, bp.TaxId2, bp.FederalTaxID, bp.VATRegistrationNumber]
    .map(normalizeField)
    .filter((v): v is string => v !== null);

  for (const val of candidates) {
    if (SIRET_RE.test(val)) return val;
  }
  for (const val of candidates) {
    if (SIREN_RE.test(val)) return val;
  }
  return null;
}

/**
 * Retourne l'identifiant TVA intracommunautaire du fournisseur (ex: FR12345678901).
 * Source principale : FederalTaxID puis VATRegistrationNumber puis TaxId*.
 */
export function getSupplierVatIdentifier(bp: BpFiscalFields): string | null {
  const candidates = [bp.FederalTaxID, bp.VATRegistrationNumber, bp.TaxId0, bp.TaxId1, bp.TaxId2]
    .map(normalizeField)
    .filter((v): v is string => v !== null);

  for (const val of candidates) {
    if (EU_VAT_RE.test(val)) return val;
  }
  return null;
}

/**
 * Récupère tous les champs fiscaux d'un BusinessPartner SAP B1.
 *
 * Retourne :
 *   BpFiscalFields  → BP trouvé avec ses champs fiscaux (champs vides = null)
 *   undefined       → SAP injoignable ou erreur réseau (vérification impossible, on ne bloque pas)
 */
export async function fetchSupplierFiscalFields(
  sapSessionCookie: string,
  cardCode: string,
): Promise<BpFiscalFields | undefined> {
  const baseUrl = ensureSapBaseUrl();
  const resource = process.env.SAP_BP_RESOURCE ?? 'BusinessPartners';
  const params = new URLSearchParams({
    $select: 'CardCode,FederalTaxID,VATRegistrationNumber,TaxId0,TaxId1,TaxId2',
    $filter: `CardCode eq ${quoteODataString(cardCode)}`,
    $top: '1',
  });

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${resource}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Cookie: normalizeSapCookieHeader(sapSessionCookie),
        Prefer: 'odata.maxpagesize=1',
      },
    });
  } catch {
    return undefined;
  }

  if (!response.ok) return undefined;

  const body = (await response.json().catch(() => ({}))) as {
    value?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(body.value) || body.value.length === 0) return undefined;

  const bp = body.value[0];
  return {
    FederalTaxID: normalizeField(bp['FederalTaxID']),
    VATRegistrationNumber: normalizeField(bp['VATRegistrationNumber']),
    TaxId0: normalizeField(bp['TaxId0']),
    TaxId1: normalizeField(bp['TaxId1']),
    TaxId2: normalizeField(bp['TaxId2']),
  };
}
