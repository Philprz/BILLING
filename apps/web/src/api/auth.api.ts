import { apiFetch } from './client';
import type { AuthUser } from './types';

export async function apiLogin(companyDb: string, userName: string, password: string): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyDb, userName, password }),
  });
}

export async function apiLogout(): Promise<void> {
  await apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

export async function apiMe(): Promise<AuthUser> {
  return apiFetch<AuthUser>('/api/auth/me');
}
