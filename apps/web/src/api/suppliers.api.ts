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
  /** N° TVA intracommunautaire (FR + 11 chiffres) → SAP FederalTaxID. */
  federalTaxId?: string;
  /** SIRET 14 chiffres → SAP AdditionalID (champ FR ; LicTradNum inexistant sur ce SL). */
  licTradNum?: string;
  /** Code de routage PA propre au fournisseur → UDF U_PA_RoutageCode. */
  routageCode?: string;
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

/**
 * Pousse une correction d'identifiants fiscaux (TVA / SIRET / Identifiant PA) vers
 * SAP B1 puis le cache local. N'envoie que les champs fournis (jamais de valeur inventée).
 */
export async function apiPatchSupplierFiscal(
  cardCode: string,
  fields: { federalTaxId?: string; licTradNum?: string; routageCode?: string },
): Promise<SupplierCache> {
  return apiFetch<SupplierCache>(`/api/suppliers/${encodeURIComponent(cardCode)}/fiscal`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
}

/**
 * Rattache des fiches doublons (alias) au bon fournisseur SAP (maître) : re-pointe
 * les factures, mémorise le mapping, pose le flag U_NOVA_Doublon sur les alias réels.
 */
export async function apiMergeSuppliers(
  masterCardcode: string,
  aliasCardcodes: string[],
  reason?: string,
): Promise<{ merged: number; invoicesRepointed: number }> {
  return apiFetch('/api/suppliers/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterCardcode, aliasCardcodes, reason }),
  });
}

export interface ReconcilePlanAlias {
  cardcode: string;
  cardname: string;
  validFor: boolean;
  invoiceCount: number;
}

export interface ReconcilePlanEntry {
  masterCardcode: string;
  masterName: string;
  aliases: ReconcilePlanAlias[];
  invoicesToRepoint: number;
}

/**
 * Aperçu (dry-run, lecture seule) de la réconciliation auto : plan des groupes à
 * maître SAP unique. Aucune écriture côté serveur.
 */
export async function apiReconcilePreview(): Promise<{
  plan: ReconcilePlanEntry[];
  groups: number;
  invoicesToRepoint: number;
}> {
  return apiFetch('/api/suppliers/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
}

/**
 * Exécute la réconciliation auto (plan recalculé serveur) : rattache les groupes à
 * maître SAP unique. Idempotent.
 */
export async function apiReconcileExecute(): Promise<{
  groupsReconciled: number;
  invoicesRepointed: number;
}> {
  return apiFetch('/api/suppliers/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: false }),
  });
}

export interface SupplierMergeItem {
  aliasCardcode: string;
  aliasName: string | null;
  masterCardcode: string;
  masterName: string | null;
  reason: string | null;
  createdAt: string;
}

/** Liste des rattachements actifs (alias → maître). */
export async function apiListSupplierMerges(): Promise<SupplierMergeItem[]> {
  return apiFetch('/api/suppliers/merges');
}

/** Détache un rattachement : ré-version des factures vers l'alias, suppression du mapping. */
export async function apiDetachSupplier(
  aliasCardcode: string,
): Promise<{ aliasCardcode: string; masterCardcode: string; invoicesReverted: number }> {
  return apiFetch(`/api/suppliers/merge/${encodeURIComponent(aliasCardcode)}`, {
    method: 'DELETE',
  });
}
