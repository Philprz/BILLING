import { apiFetch } from './client';
import type { AuditEntry, AuditAction, AuditOutcome, PaginatedResult } from './types';

export interface GetAuditParams {
  page?:       number;
  limit?:      number;
  entityId?:   string;
  action?:     AuditAction;
  outcome?:    AuditOutcome;
  entityType?: string;
  dateFrom?:   string;
  dateTo?:     string;
}

export async function apiGetAudit(params: GetAuditParams = {}): Promise<PaginatedResult<AuditEntry>> {
  const qs = new URLSearchParams();
  if (params.page)       qs.set('page',       String(params.page));
  if (params.limit)      qs.set('limit',      String(params.limit));
  if (params.entityId)   qs.set('entityId',   params.entityId);
  if (params.action)     qs.set('action',     params.action);
  if (params.outcome)    qs.set('outcome',    params.outcome);
  if (params.entityType) qs.set('entityType', params.entityType);
  if (params.dateFrom)   qs.set('dateFrom',   params.dateFrom);
  if (params.dateTo)     qs.set('dateTo',     params.dateTo);
  return apiFetch<PaginatedResult<AuditEntry>>(`/api/audit?${qs.toString()}`);
}
