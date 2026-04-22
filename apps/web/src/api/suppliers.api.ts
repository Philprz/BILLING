import { apiFetch } from './client';
import type { PaginatedResult } from './types';

export interface SupplierCache {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  syncAt: string;
}

export async function apiGetSuppliers(search?: string): Promise<PaginatedResult<SupplierCache>> {
  const params = new URLSearchParams({ limit: '200' });
  if (search) params.set('search', search);
  return apiFetch<PaginatedResult<SupplierCache>>(`/api/suppliers-cache?${params}`);
}
