import { apiFetch } from './client';

export interface MappingRule {
  id: string;
  scope: 'GLOBAL' | 'SUPPLIER';
  supplierCardcode: string | null;
  matchKeyword: string | null;
  matchTaxRate: number | null;
  matchAmountMin: number | null;
  matchAmountMax: number | null;
  accountCode: string;
  costCenter: string | null;
  taxCodeB1: string | null;
  confidence: number;
  usageCount: number;
  active: boolean;
  createdByUser: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateMappingRuleBody {
  scope: 'GLOBAL' | 'SUPPLIER';
  supplierCardcode?: string | null;
  matchKeyword?: string | null;
  matchTaxRate?: number | null;
  accountCode: string;
  costCenter?: string | null;
  taxCodeB1?: string | null;
  confidence?: number;
}

export async function apiGetMappingRules(): Promise<MappingRule[]> {
  return apiFetch<MappingRule[]>('/api/mapping-rules');
}

export async function apiCreateMappingRule(body: CreateMappingRuleBody): Promise<MappingRule> {
  return apiFetch<MappingRule>('/api/mapping-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiDeleteMappingRule(id: string): Promise<void> {
  await apiFetch<void>(`/api/mapping-rules/${id}`, { method: 'DELETE' });
}

export interface TestRuleResult {
  matched: boolean;
  rule: {
    id: string;
    scope: string;
    accountCode: string;
    costCenter: string | null;
    taxCodeB1: string | null;
    confidence: number;
    score: number;
    matchKeyword: string | null;
  } | null;
  candidatesCount: number;
}

export async function apiTestRule(body: {
  description: string;
  amountExclTax?: number;
  taxRate?: number | null;
  supplierCardcode?: string | null;
}): Promise<TestRuleResult> {
  return apiFetch<TestRuleResult>('/api/mapping-rules/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function mappingRulesExportUrl(): string {
  return '/api/mapping-rules/export.csv';
}

export async function apiImportRules(csv: string): Promise<{ created: number; skipped: number }> {
  return apiFetch<{ created: number; skipped: number }>('/api/mapping-rules/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
}
