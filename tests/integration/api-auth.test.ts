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

  it('uses the NOVA PA idle timeout regardless of SAP SessionTimeout', async () => {
    const app = buildApp();
    await app.ready();

    // SAP annonce un SessionTimeout court (20 min) — la spec NOVA PA dit qu'on
    // l'ignore et qu'on applique nos propres timeouts (idle 30 min, absolu 8h).
    // Si le B1SESSION expire avant côté SAP, l'helper sapFetch interceptera le 401.
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
    const body = response.json().data;
    expect(body.user).toBe('manager');
    expect(body.role).toBe('ADMIN');
    expect(body.displayName).toContain('Manager');
    const remainingMs = new Date(body.expiresAt).getTime() - Date.now();
    // expiresAt = min(idle 30min, absolu 8h) = ~30 min
    expect(remainingMs).toBeGreaterThan(28 * 60_000);
    expect(remainingMs).toBeLessThanOrEqual(30 * 60_000 + 5_000);

    await app.close();
  });

  it('rejects with USER_NOT_PROVISIONED when SAP user has no app_users entry', async () => {
    const app = buildApp();
    await app.ready();

    const loginResponse = jsonResponse({ SessionTimeout: 30 }, 200, [
      ['content-type', 'application/json'],
      ['set-cookie', 'B1SESSION=LOGIN-SESSION; Path=/; HttpOnly'],
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
        userName: 'not_in_app_users_' + Date.now(),
        password: 'secret',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('USER_NOT_PROVISIONED');

    await app.close();
  });

  it('extends the web session when SAP keepalive succeeds', async () => {
    const { app, cookieHeader, session, csrfToken } = await buildAuthenticatedApp('keepalive.user');
    const previousExpiresAt = session.expiresAt.getTime();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ CompanyName: 'Demo' })),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/keepalive',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(200);
    const nextExpiresAt = new Date(response.json().data.expiresAt).getTime();
    expect(nextExpiresAt).toBeGreaterThan(previousExpiresAt);

    await app.close();
  });

  it('invalidates the local session when SAP keepalive fails', async () => {
    const { app, cookieHeader, csrfToken } = await buildAuthenticatedApp('keepalive.user');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 401)),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/keepalive',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('SESSION_EXPIRED');

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader },
    });

    expect(meResponse.statusCode).toBe(401);

    await app.close();
  });
});
