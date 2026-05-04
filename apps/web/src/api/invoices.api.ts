import { apiFetch } from './client';
import type {
  InvoiceSummary,
  InvoiceDetail,
  InvoiceFile,
  PaginatedResult,
  BasicSettings,
  InvoiceStatus,
  SapExecutionPolicy,
  SapValidationReport,
  SapPurchaseInvoiceRef,
} from './types';

export interface GetInvoicesParams {
  page?: number;
  limit?: number;
  status?: InvoiceStatus | 'ACTIVE' | 'ALL';
  paSource?: string;
  search?: string;
  direction?: 'INVOICE' | 'CREDIT_NOTE';
  amountMin?: number;
  amountMax?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export async function apiGetInvoices(
  params: GetInvoicesParams = {},
): Promise<PaginatedResult<InvoiceSummary>> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.status && params.status !== 'ALL') qs.set('status', params.status);
  if (params.paSource) qs.set('paSource', params.paSource);
  if (params.search) qs.set('search', params.search);
  if (params.direction) qs.set('direction', params.direction);
  if (params.amountMin !== undefined) qs.set('amountMin', String(params.amountMin));
  if (params.amountMax !== undefined) qs.set('amountMax', String(params.amountMax));
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  if (params.sortDir) qs.set('sortDir', params.sortDir);
  return apiFetch<PaginatedResult<InvoiceSummary>>(`/api/invoices?${qs.toString()}`);
}

export async function apiGetInvoice(id: string): Promise<InvoiceDetail> {
  return apiFetch<InvoiceDetail>(`/api/invoices/${id}`);
}

export async function apiGetInvoiceFiles(id: string): Promise<InvoiceFile[]> {
  return apiFetch<InvoiceFile[]>(`/api/invoices/${id}/files`);
}

export async function apiGetBasicSettings(): Promise<BasicSettings> {
  return apiFetch<BasicSettings>('/api/settings/basic');
}

export interface PostInvoiceParams {
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  simulate?: boolean;
}

export interface PostInvoiceResult {
  sapDocEntry: number;
  sapDocNum: number;
  sapAttachmentEntry: number | null;
  integrationMode: string;
  simulate: boolean;
  status: string;
  attachmentWarning: string | null;
  validationReport?: SapValidationReport;
  policy?: SapExecutionPolicy;
}

export async function apiPostInvoice(
  id: string,
  params: PostInvoiceParams,
): Promise<PostInvoiceResult> {
  return apiFetch<PostInvoiceResult>(`/api/invoices/${id}/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function apiRejectInvoice(id: string, reason: string): Promise<void> {
  await apiFetch<unknown>(`/api/invoices/${id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export interface SendStatusResult {
  paStatusSentAt: string;
  outcome: 'VALIDATED' | 'REJECTED';
}

export async function apiSendStatus(id: string): Promise<SendStatusResult> {
  return apiFetch<SendStatusResult>(`/api/invoices/${id}/send-status`, {
    method: 'POST',
  });
}

export async function apiResetInvoice(id: string): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${id}/reset`, { method: 'POST' });
}

export async function apiUpdateSupplier(
  invoiceId: string,
  supplierB1Cardcode: string | null,
): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${invoiceId}/supplier`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supplierB1Cardcode }),
  });
}

export interface PatchLineParams {
  chosenAccountCode?: string | null;
  chosenCostCenter?: string | null;
  chosenTaxCodeB1?: string | null;
  taxCodeLockedByUser?: boolean;
}

export async function apiUpdateLine(
  invoiceId: string,
  lineId: string,
  data: PatchLineParams,
): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${invoiceId}/lines/${lineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export type TaxCodeSource =
  | 'account_mapping'
  | 'supplier_history'
  | 'global_history'
  | 'vat_rate_mapping'
  | 'none';

export interface TaxCodeResolution {
  taxCode: string | null;
  source: TaxCodeSource;
}

export async function apiResolveTaxCode(
  invoiceId: string,
  lineId: string,
  accountCode: string,
): Promise<TaxCodeResolution> {
  return apiFetch<TaxCodeResolution>(
    `/api/invoices/${invoiceId}/lines/${lineId}/resolve-tax-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountCode }),
    },
  );
}

export async function apiSaveDraft(
  id: string,
  data: { integrationMode?: string; sapSeries?: string },
): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${id}/draft`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function apiReEnrichInvoice(id: string): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${id}/re-enrich`, {
    method: 'POST',
  });
}

export async function apiReParseLinesInvoice(id: string): Promise<import('./types').InvoiceDetail> {
  return apiFetch<import('./types').InvoiceDetail>(`/api/invoices/${id}/re-parse-lines`, {
    method: 'POST',
  });
}

export interface PushSupplierFiscalResult {
  cardCode: string;
  taxId0: string | null;
  federalTaxId: string | null;
}

export async function apiPushSupplierFiscal(id: string): Promise<PushSupplierFiscalResult> {
  return apiFetch<PushSupplierFiscalResult>(`/api/invoices/${id}/push-supplier-fiscal`, {
    method: 'POST',
  });
}

export async function apiReEnrichAll(): Promise<{ processed: number; errors: number }> {
  return apiFetch<{ processed: number; errors: number }>('/api/invoices/re-enrich-all', {
    method: 'POST',
  });
}

export interface DailyStatDay {
  date: string;
  received: number;
  posted: number;
}

export async function apiGetDailyStats(): Promise<{ days: DailyStatDay[] }> {
  return apiFetch<{ days: DailyStatDay[] }>('/api/invoices/stats/daily');
}

export interface BulkPostResult {
  results: { id: string; ok: boolean; error?: string; sapDocNum?: number }[];
  succeeded: number;
  failed: number;
}

export async function apiBulkPost(ids: string[]): Promise<BulkPostResult> {
  return apiFetch<BulkPostResult>('/api/invoices/bulk-post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export interface BulkSendStatusResult {
  results: { id: string; ok: boolean; error?: string }[];
  succeeded: number;
  failed: number;
}

export async function apiBulkSendStatus(ids: string[]): Promise<BulkSendStatusResult> {
  return apiFetch<BulkSendStatusResult>('/api/invoices/bulk-send-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export type LinkSapOkResult = {
  status: 'LINKED';
  sapDocEntry: number;
  sapDocNum: number;
  attachmentEntry: number | null;
  invoice: InvoiceDetail;
};

export type LinkSapConflictResult = {
  conflict: true;
  candidates: SapPurchaseInvoiceRef[];
  message: string;
};

export async function apiLinkSap(id: string): Promise<LinkSapOkResult | LinkSapConflictResult> {
  // Gestion manuelle des codes HTTP 404 / 409 pour exposer les candidats
  const res = await fetch(`/api/invoices/${id}/link-sap`, { method: 'POST' });

  if (res.status === 409) {
    const body = (await res.json()) as {
      error: string;
      data?: { candidates: SapPurchaseInvoiceRef[] };
    };
    return { conflict: true, candidates: body.data?.candidates ?? [], message: body.error };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Erreur ${res.status}`);
  }

  const body = (await res.json()) as { success: boolean; data: InvoiceDetail };
  const inv = body.data;
  return {
    status: 'LINKED',
    sapDocEntry: inv.sapDocEntry!,
    sapDocNum: inv.sapDocNum!,
    attachmentEntry: inv.sapAttachmentEntry,
    invoice: inv,
  };
}
