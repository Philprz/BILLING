import { describe, it, expect, vi, type Mock } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyCsrf } from '../../apps/api/src/middleware/csrf';

function makeRequest(
  overrides: Partial<{
    method: string;
    url: string;
    cookies: Record<string, string>;
    headers: Record<string, string>;
  }>,
): FastifyRequest {
  return {
    method: 'GET',
    url: '/api/test',
    cookies: {},
    headers: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(): { reply: FastifyReply; code: Mock; send: Mock } {
  const send: Mock = vi.fn().mockReturnThis();
  const code: Mock = vi.fn().mockReturnValue({ send });
  const reply = { code, send } as unknown as FastifyReply;
  return { reply, code, send };
}

describe('verifyCsrf', () => {
  it('laisse passer les requêtes GET sans token', async () => {
    const request = makeRequest({ method: 'GET' });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('laisse passer les requêtes HEAD sans token', async () => {
    const request = makeRequest({ method: 'HEAD' });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('laisse passer les requêtes OPTIONS sans token', async () => {
    const request = makeRequest({ method: 'OPTIONS' });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('laisse passer POST /api/auth/login sans token (exemption de la route)', async () => {
    const request = makeRequest({ method: 'POST', url: '/api/auth/login' });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('laisse passer POST /api/auth/login avec query string', async () => {
    const request = makeRequest({ method: 'POST', url: '/api/auth/login?foo=bar' });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('rejette POST sans cookie csrf_token', async () => {
    const request = makeRequest({
      method: 'POST',
      url: '/api/invoices',
      cookies: {},
      headers: { 'x-csrf-token': 'abc123' },
    });
    const { reply, code, send } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({ success: false, error: 'CSRF token invalide' });
  });

  it('rejette POST sans header X-CSRF-Token', async () => {
    const request = makeRequest({
      method: 'POST',
      url: '/api/invoices',
      cookies: { csrf_token: 'abc123' },
      headers: {},
    });
    const { reply, code, send } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({ success: false, error: 'CSRF token invalide' });
  });

  it('rejette POST quand cookie ≠ header', async () => {
    const request = makeRequest({
      method: 'POST',
      url: '/api/invoices',
      cookies: { csrf_token: 'token-A' },
      headers: { 'x-csrf-token': 'token-B' },
    });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).toHaveBeenCalledWith(403);
  });

  it('accepte POST quand cookie === header', async () => {
    const request = makeRequest({
      method: 'POST',
      url: '/api/invoices',
      cookies: { csrf_token: 'same-token-xyz' },
      headers: { 'x-csrf-token': 'same-token-xyz' },
    });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('accepte PUT avec token valide', async () => {
    const request = makeRequest({
      method: 'PUT',
      url: '/api/settings/TIMEOUT',
      cookies: { csrf_token: 'tok' },
      headers: { 'x-csrf-token': 'tok' },
    });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('accepte PATCH avec token valide', async () => {
    const request = makeRequest({
      method: 'PATCH',
      url: '/api/invoices/123',
      cookies: { csrf_token: 'tok' },
      headers: { 'x-csrf-token': 'tok' },
    });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });

  it('accepte DELETE avec token valide', async () => {
    const request = makeRequest({
      method: 'DELETE',
      url: '/api/mapping-rules/123',
      cookies: { csrf_token: 'tok' },
      headers: { 'x-csrf-token': 'tok' },
    });
    const { reply, code } = makeReply();
    await verifyCsrf(request, reply);
    expect(code).not.toHaveBeenCalled();
  });
});
