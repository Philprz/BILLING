import { apiFetch } from './client';
import type { InvoiceSummary, InvoiceDetail, InvoiceFile, PaginatedResult, BasicSettings, InvoiceStatus } from './types';

export interface GetInvoicesParams {
  page?: number;
  limit?: number;
  status?: InvoiceStatus;
  paSource?: string;
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export async function apiGetInvoices(params: GetInvoicesParams = {}): Promise<PaginatedResult<InvoiceSummary>> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.status) qs.set('status', params.status);
  if (params.paSource) qs.set('paSource', params.paSource);
  if (params.search) qs.set('search', params.search);
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
  sapDocEntry:        number;
  sapDocNum:          number;
  sapAttachmentEntry: number;
  integrationMode:    string;
  simulate:           boolean;
  status:             string;
}

export async function apiPostInvoice(id: string, params: PostInvoiceParams): Promise<PostInvoiceResult> {
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
