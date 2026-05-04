import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { normalizeSapCookieHeader, sapLogin, sapLogout } from './sap-auth.service';

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const DEFAULT_PAGE_SIZE = 200;

export interface SupplierSyncError {
  cardcode?: string;
  message: string;
}

export interface SupplierSyncResult {
  inserted: number;
  updated: number;
  disabled: number;
  total: number;
  errors: SupplierSyncError[];
}

export interface SupplierSyncStatus {
  lastSyncAt: string | null;
  totalCached: number;
  activeCached: number;
  lastResult: SupplierSyncResult | null;
  lastError: string | null;
}

type SapBpPayload = Record<string, unknown>;

function textField(row: SapBpPayload, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function boolField(row: SapBpPayload, keys: string[], defaultValue: boolean): boolean {
  for (const key of keys) {
    const value = row[key];
    if (value === true || value === 'tYES' || value === 'Y' || value === 'YES') return true;
    if (value === false || value === 'tNO' || value === 'N' || value === 'NO') return false;
  }
  return defaultValue;
}

function supplierIsValid(row: SapBpPayload): boolean {
  const valid = boolField(row, ['Valid', 'ValidFor'], true);
  const frozen = boolField(row, ['Frozen'], false);
  return valid && !frozen;
}

function primaryAddress(row: SapBpPayload): Record<string, unknown> | null {
  const addresses = row.BPAddresses;
  if (!Array.isArray(addresses)) return null;
  const billTo = addresses.find((a) => {
    const address = a as Record<string, unknown>;
    return address.AddressType === 'bo_BillTo' || address.AddressType === 'BillTo';
  });
  return (
    (billTo as Record<string, unknown> | undefined) ??
    (addresses[0] as Record<string, unknown> | undefined) ??
    null
  );
}

export function mapSapSupplierForCache(
  row: SapBpPayload,
  syncedAt: Date,
): Prisma.SupplierCacheUncheckedCreateInput {
  const address = primaryAddress(row);
  const cardcode = textField(row, ['CardCode']);
  const cardname = textField(row, ['CardName']);
  if (!cardcode || !cardname) {
    throw new Error('Réponse SAP BusinessPartners invalide : CardCode/CardName manquant');
  }

  return {
    cardcode,
    cardname,
    cardtype: textField(row, ['CardType']),
    federaltaxid: textField(row, ['FederalTaxID']), // TVA intracommunautaire
    vatregnum: textField(row, ['VATRegistrationNumber', 'VatRegistrationNumber', 'VatRegNum']),
    taxId0: textField(row, ['AdditionalID']), // SIREN
    taxId1: textField(row, ['UnifiedFederalTaxID']), // SIRET
    taxId2: textField(row, ['TaxId2']),
    phone1: textField(row, ['Phone1']),
    email: textField(row, ['EmailAddress', 'Email']),
    address: address ? textField(address, ['Street', 'AddressName', 'Block']) : null,
    city: address ? textField(address, ['City']) : textField(row, ['City']),
    zipCode: address ? textField(address, ['ZipCode']) : textField(row, ['ZipCode']),
    country: address ? textField(address, ['Country']) : textField(row, ['Country']),
    validFor: supplierIsValid(row),
    rawPayload: row as Prisma.InputJsonObject,
    lastSyncAt: syncedAt,
    syncAt: syncedAt,
  };
}

function nextLinkUrl(nextLink: unknown): string | null {
  if (typeof nextLink !== 'string' || !nextLink.trim()) return null;
  if (/^https?:\/\//i.test(nextLink)) return nextLink;
  return `${SAP_BASE_URL}/${nextLink.replace(/^\/+/, '')}`;
}

export async function fetchSuppliersFromSap(
  sapSessionCookie: string,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<SapBpPayload[]> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non configurée');

  const cookie = normalizeSapCookieHeader(sapSessionCookie);
  const rows: SapBpPayload[] = [];
  let skip = 0;
  let url: string | null =
    `${SAP_BASE_URL}/BusinessPartners?$filter=${encodeURIComponent("CardType eq 'cSupplier'")}` +
    `&$orderby=CardCode&$top=${pageSize}&$skip=0`;

  while (url) {
    const res = await fetch(url, {
      headers: { Cookie: cookie, Prefer: `odata.maxpagesize=${pageSize}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`SAP BusinessPartners (${res.status}) : ${text.slice(0, 500)}`);
    }

    const body = (await res.json().catch(() => ({ value: [] }))) as {
      value?: SapBpPayload[];
      '@odata.nextLink'?: string;
      'odata.nextLink'?: string;
    };
    const page = Array.isArray(body.value) ? body.value : [];
    rows.push(...page);

    url = nextLinkUrl(body['@odata.nextLink'] ?? body['odata.nextLink']);
    if (!url) {
      if (page.length < pageSize) break;
      skip += pageSize;
      url =
        `${SAP_BASE_URL}/BusinessPartners?$filter=${encodeURIComponent("CardType eq 'cSupplier'")}` +
        `&$orderby=CardCode&$top=${pageSize}&$skip=${skip}`;
    }
  }

  return rows;
}

async function auditSync(
  outcome: 'OK' | 'ERROR',
  result: Partial<SupplierSyncResult>,
  errorMessage?: string,
  sapUser?: string | null,
): Promise<void> {
  await createAuditLogBestEffort({
    action: 'SYNC_SUPPLIERS',
    entityType: 'SYSTEM',
    entityId: 'suppliers_cache',
    sapUser: sapUser ?? null,
    outcome,
    errorMessage: errorMessage ?? null,
    payloadAfter: result as Prisma.InputJsonObject,
  });
}

export async function syncSuppliersFromSap(
  sapSessionCookie: string,
  sapUser?: string | null,
): Promise<SupplierSyncResult> {
  const syncedAt = new Date();
  const errors: SupplierSyncError[] = [];

  try {
    const rows = await fetchSuppliersFromSap(sapSessionCookie);
    const incomingCardcodes = new Set<string>();
    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      try {
        const mapped = mapSapSupplierForCache(row, syncedAt);
        incomingCardcodes.add(mapped.cardcode);
        const existing = await prisma.supplierCache.findUnique({
          where: { cardcode: mapped.cardcode },
          select: { cardcode: true },
        });
        if (existing) {
          await prisma.supplierCache.update({
            where: { cardcode: mapped.cardcode },
            data: mapped,
          });
          updated++;
        } else {
          await prisma.supplierCache.create({ data: mapped });
          inserted++;
        }
      } catch (err) {
        errors.push({
          cardcode: textField(row, ['CardCode']) ?? undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const disabled = await prisma.supplierCache.updateMany({
      where: {
        validFor: true,
        cardcode: { notIn: [...incomingCardcodes] },
      },
      data: { validFor: false, lastSyncAt: syncedAt, syncAt: syncedAt },
    });

    const result: SupplierSyncResult = {
      inserted,
      updated,
      disabled: disabled.count,
      total: rows.length,
      errors,
    };
    await auditSync(errors.length === 0 ? 'OK' : 'ERROR', result, errors[0]?.message, sapUser);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = { inserted: 0, updated: 0, disabled: 0, total: 0, errors: [{ message }] };
    await auditSync('ERROR', result, message, sapUser);
    return result;
  }
}

export async function syncSuppliersFromSapEnv(): Promise<SupplierSyncResult> {
  const companyDb = process.env.SAP_CLIENT ?? '';
  const userName = process.env.SAP_USER ?? '';
  const password = process.env.SAP_CLIENT_PASSWORD ?? '';
  if (!companyDb || !userName || !password) {
    const message = 'Variables SAP manquantes pour la synchro automatique fournisseurs';
    const result = { inserted: 0, updated: 0, disabled: 0, total: 0, errors: [{ message }] };
    await auditSync('ERROR', result, message, 'SYSTEM');
    return result;
  }

  const login = await sapLogin(companyDb, userName, password);
  try {
    return await syncSuppliersFromSap(login.sapCookieHeader, userName);
  } finally {
    await sapLogout(login.sapCookieHeader).catch(() => {});
  }
}

export async function getSuppliersSyncStatus(): Promise<SupplierSyncStatus> {
  const [totalCached, activeCached, latestAudit] = await Promise.all([
    prisma.supplierCache.count(),
    prisma.supplierCache.count({ where: { validFor: true } }),
    prisma.auditLog.findFirst({
      where: { action: 'SYNC_SUPPLIERS' },
      orderBy: { occurredAt: 'desc' },
    }),
  ]);

  const lastResult =
    latestAudit?.payloadAfter && typeof latestAudit.payloadAfter === 'object'
      ? (latestAudit.payloadAfter as unknown as SupplierSyncResult)
      : null;

  return {
    lastSyncAt: latestAudit?.occurredAt.toISOString() ?? null,
    totalCached,
    activeCached,
    lastResult,
    lastError: latestAudit?.outcome === 'ERROR' ? latestAudit.errorMessage : null,
  };
}
