import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@pa-sap-bridge/database';
import { buildAuthenticatedApp } from '../helpers/http';

describe.sequential('API pa-channels integration', () => {
  const createdIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildAuthenticatedApp>>['app'];
  let cookieHeader: string;

  beforeAll(async () => {
    const built = await buildAuthenticatedApp('pa-channel.tester');
    app = built.app;
    cookieHeader = built.cookieHeader;
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.paChannel.deleteMany({ where: { id: { in: createdIds } } });
    }
    await app.close();
  });

  afterEach(async () => {
    // Nettoyage entre tests pour éviter les collisions de nom unique
  });

  // ── GET ────────────────────────────────────────────────────────────────────

  it('requires authentication on GET /api/pa-channels', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pa-channels' });
    expect(res.statusCode).toBe(401);
  });

  it('returns an empty list or existing channels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/pa-channels',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: unknown[] }>();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  // ── POST ───────────────────────────────────────────────────────────────────

  it('creates a SFTP channel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pa-channels',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: {
        name: 'test-sftp-vitest',
        protocol: 'SFTP',
        host: 'sftp.example.com',
        port: 22,
        user: 'ftp_user',
        password: 'secret',
        remotePathIn: '/in',
        pollIntervalSeconds: 60,
        active: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      success: boolean;
      data: { id: string; name: string; passwordEncrypted: string | null };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('test-sftp-vitest');
    expect(body.data.passwordEncrypted).toBe('••••••••');
    createdIds.push(body.data.id);
  });

  it('rejects a channel with missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pa-channels',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: { protocol: 'SFTP' }, // name absent
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates an API channel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pa-channels',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: {
        name: 'test-api-vitest',
        protocol: 'API',
        apiBaseUrl: 'https://api.example.com/v1',
        apiAuthType: 'API_KEY',
        apiCredentials: '{"key":"tok_test"}',
        pollIntervalSeconds: 120,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      success: boolean;
      data: { id: string; apiCredentialsEncrypted: string | null };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.apiCredentialsEncrypted).toBe('••••••••');
    createdIds.push(body.data.id);
  });

  // ── PATCH ──────────────────────────────────────────────────────────────────

  it('patches a channel (toggle active)', async () => {
    const id = createdIds[0];
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/pa-channels/${id}`,
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: { active: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: { active: boolean } }>();
    expect(body.data.active).toBe(false);
  });

  it('returns 404 when patching unknown channel', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/pa-channels/00000000-0000-0000-0000-000000000000',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: { active: true },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────

  it('deletes a channel', async () => {
    const id = createdIds.pop()!;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/pa-channels/${id}`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean }>();
    expect(body.success).toBe(true);

    const inDb = await prisma.paChannel.findUnique({ where: { id } });
    expect(inDb).toBeNull();
  });

  it('returns 404 when deleting unknown channel', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/pa-channels/00000000-0000-0000-0000-000000000000',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
  });
});
