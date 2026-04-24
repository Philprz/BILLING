import { apiFetch } from './client';
import type { PaginatedResult } from './types';

export interface SupplierCache {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  syncAt: string;
  invoiceCount: number;
}

export async function apiGetSuppliers(search?: string): Promise<PaginatedResult<SupplierCache>> {
  const params = new URLSearchParams({ limit: '200' });
  if (search) params.set('search', search);
  return apiFetch<PaginatedResult<SupplierCache>>(`/api/suppliers-cache?${params}`);
}

export interface CreateSupplierPayload {
  cardCode: string;
  cardName: string;
  federalTaxId?: string;
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
