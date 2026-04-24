import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { buildAuthenticatedApp } from '../helpers/http';

describe.sequential('API auth session lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(
    body: unknown,
    status = 200,
    headers: HeadersInit = { 'content-type': 'application/json' },
  ): Response {
    return new Response(JSON.stringify(body), { status, headers });
  }

  it('caps local session lifetime to the SAP timeout returned at login', async () => {
    const app = buildApp();
    await app.ready();

    const loginResponse = jsonResponse({ SessionTimeout: 20 }, 200, [
      ['content-type', 'application/json'],
      ['set-cookie', 'B1SESSION=LOGIN-SESSION; Path=/; HttpOnly'],
      ['set-cookie', 'ROUTEID=.node1; Path=/; HttpOnly'],
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => loginResponse),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: {
        companyDb: 'SBODemoFR',
        userName: 'manager',
        password: 'secret',
      },
    });

    expect(response.statusCode).toBe(200);
    const expiresAt = new Date(response.json().data.expiresAt);
    const remainingMs = expiresAt.getTime() - Date.now();
    expect(remainingMs).toBeLessThanOrEqual(20 * 60_000 + 5_000);
    expect(remainingMs).toBeGreaterThan(18 * 60_000);

    await app.close();
  });

  it('extends the web session when SAP keepalive succeeds', async () => {
    const { app, cookieHeader, session } = await buildAuthenticatedApp('keepalive.user');
    const previousExpiresAt = session.expiresAt.getTime();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ CompanyName: 'Demo' })),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/keepalive',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    const nextExpiresAt = new Date(response.json().data.expiresAt).getTime();
    expect(nextExpiresAt).toBeGreaterThan(previousExpiresAt);

    await app.close();
  });

  it('invalidates the local session when SAP keepalive fails', async () => {
    const { app, cookieHeader } = await buildAuthenticatedApp('keepalive.user');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/keepalive',
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain('Session SAP expirée');

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader },
    });

    expect(meResponse.statusCode).toBe(401);

    await app.close();
  });
});
