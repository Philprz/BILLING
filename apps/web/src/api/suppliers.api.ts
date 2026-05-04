import { apiFetch } from './client';
import type { PaginatedResult } from './types';

export interface SupplierCache {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  taxId0: string | null;
  taxId1: string | null;
  taxId2: string | null;
  phone1: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  validFor: boolean;
  /** Identifiant PA (Plateforme Agréée) pour routage des factures électroniques. */
  pa_identifier: string | null;
  syncAt: string;
  lastSyncAt: string;
  invoiceCount: number;
}

export interface SupplierSyncResult {
  inserted: number;
  updated: number;
  disabled: number;
  total: number;
  errors: Array<{ cardcode?: string; message: string }>;
}

export interface SupplierSyncStatus {
  lastSyncAt: string | null;
  totalCached: number;
  activeCached: number;
  lastResult: SupplierSyncResult | null;
  lastError: string | null;
}

export async function apiGetSuppliers(search?: string): Promise<PaginatedResult<SupplierCache>> {
  const params = new URLSearchParams({ limit: '200' });
  if (search) params.set('search', search);
  return apiFetch<PaginatedResult<SupplierCache>>(`/api/suppliers-cache?${params}`);
}

export async function apiSearchSuppliers(
  q: string,
): Promise<{ items: SupplierCache[]; total: number }> {
  return apiFetch(`/api/suppliers/search?q=${encodeURIComponent(q)}&limit=20`);
}

export async function apiSyncSuppliers(): Promise<SupplierSyncResult> {
  return apiFetch<SupplierSyncResult>('/api/suppliers/sync', { method: 'POST' });
}

export async function apiGetSuppliersSyncStatus(): Promise<SupplierSyncStatus> {
  return apiFetch<SupplierSyncStatus>('/api/suppliers/sync/status');
}

export interface CreateSupplierPayload {
  cardCode: string;
  cardName: string;
  federalTaxId?: string;
  vatRegNum?: string;
  street?: string;
  street2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  phone?: string;
  invoiceId?: string;
}

export async function apiCreateSupplierInSap(
  payload: CreateSupplierPayload,
): Promise<{ cardCode: string; cardName: string }> {
  return apiFetch<{ cardCode: string; cardName: string }>('/api/suppliers/create-in-sap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
