import { apiFetch } from './client';

export interface SapAccount {
  acctCode: string;
  acctName: string;
  activeAccount: boolean;
  postable: boolean;
  accountLevel: number | null;
  groupMask: number | null;
}

export async function apiSearchSapAccounts(q: string): Promise<SapAccount[]> {
  if (q.trim().length < 1) return [];
  const qs = new URLSearchParams({ q });
  return apiFetch<SapAccount[]>(`/api/sap/accounts/search?${qs.toString()}`);
}

export interface SapChartSyncResult {
  imported: number;
  activePostable: number;
  syncedAt: string;
}

export async function apiCreateSapUdfPaRef(): Promise<{
  alreadyExists: boolean;
  fieldName: string;
}> {
  return apiFetch('/api/sap/setup/udf-pa-ref', { method: 'POST' });
}

export async function apiListChartOfAccounts(search?: string): Promise<SapAccount[]> {
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  const url = `/api/sap/chart-of-accounts${search ? `?${qs.toString()}` : ''}`;
  return apiFetch<SapAccount[]>(url);
}

export async function apiSyncSapChartOfAccounts(): Promise<SapChartSyncResult> {
  return apiFetch<SapChartSyncResult>('/api/sap/chart-of-accounts/sync', {
    method: 'POST',
  });
}

export async function apiSyncSapVatCodes(): Promise<{ imported: number; source: string }> {
  return apiFetch<{ imported: number; source: string }>('/api/sap/vat-codes/sync', {
    method: 'POST',
  });
}

export async function apiGetSapVatCodes(): Promise<
  { code: string; name: string; rate: number; active: boolean }[]
> {
  return apiFetch<{ code: string; name: string; rate: number; active: boolean }[]>(
    '/api/sap/vat-codes',
  );
}

export async function apiGetDiagnostics(): Promise<{
  chartOfAccounts: { source: string; count: number; sample: SapAccount[] };
  vatCodes: {
    source: string;
    count: number;
    sample: { code: string; rate: number; name: string }[];
  };
}> {
  return apiFetch('/api/diagnostics/sap-references');
}
