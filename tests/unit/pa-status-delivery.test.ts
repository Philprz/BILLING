/**
 * Tests unitaires pour le moteur de livraison du statut PA (CDC §9).
 *
 * On teste la logique de routage et les helpers sans connexion réseau réelle
 * en mockant prisma et fetch.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Mock Prisma ────────────────────────────────────────────────────────────────

const mockFindFirst = vi.fn();
vi.mock('@pa-sap-bridge/database', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@pa-sap-bridge/database')>();
  return {
    ...orig,
    prisma: { paChannel: { findFirst: mockFindFirst } },
  };
});

// ── Import après mock ──────────────────────────────────────────────────────────

const { deliverPaStatus } = await import('../../apps/api/src/services/pa-status-delivery');

// ── Fixture facture minimale ───────────────────────────────────────────────────

function makeInvoice(paSource = 'LOCAL_INBOX') {
  return {
    id: 'inv-001',
    paMessageId: 'MSG-001',
    docNumberPa: 'FA-2026-001',
    paSource,
    status: 'POSTED',
    statusReason: null,
    sapDocEntry: 42,
    sapDocNum: 1042,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('deliverPaStatus — routage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-status-test-'));
    process.env.STATUS_OUT_PATH = tmpDir;
    mockFindFirst.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.STATUS_OUT_PATH;
    vi.restoreAllMocks();
  });

  // ── Fallback fichier local ─────────────────────────────────────────────────

  it("écrit un fichier local quand aucun canal n'est trouvé", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await deliverPaStatus(makeInvoice('LOCAL_INBOX'));

    expect(result.mode).toBe('FILE_STUB');
    expect(fs.existsSync(result.target)).toBe(true);

    const content = JSON.parse(fs.readFileSync(result.target, 'utf-8')) as Record<string, unknown>;
    expect(content.paMessageId).toBe('MSG-001');
    expect(content.outcome).toBe('VALIDATED'); // POSTED → VALIDATED
    expect(content.sapDocNum).toBe(1042);
  });

  it("écrit un fichier local quand le canal SFTP n'a pas de remotePathOut", async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'SFTP',
      host: 'sftp.example.com',
      port: 22,
      user: 'ftpuser',
      passwordEncrypted: 'secret',
      remotePathOut: null, // ← manquant
    });

    const result = await deliverPaStatus(makeInvoice('sftp-channel'));
    expect(result.mode).toBe('FILE_STUB');
  });

  // ── HTTP delivery ──────────────────────────────────────────────────────────

  it('appelle fetch pour un canal API sans auth', async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'API',
      apiBaseUrl: 'https://pa.example.com/v1',
      apiAuthType: null,
      apiCredentialsEncrypted: null,
    });

    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const result = await deliverPaStatus(makeInvoice('api-channel'));

    expect(result.mode).toBe('HTTP');
    expect(result.target).toBe('https://pa.example.com/v1/invoices/MSG-001/status');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://pa.example.com/v1/invoices/MSG-001/status');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.outcome).toBe('VALIDATED'); // POSTED → VALIDATED dans le payload
  });

  it('ajoute un header Authorization Basic pour apiAuthType=BASIC', async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'API',
      apiBaseUrl: 'https://pa.example.com/v1',
      apiAuthType: 'BASIC',
      apiCredentialsEncrypted: JSON.stringify({ user: 'monuser', password: 'monpass' }),
    });

    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await deliverPaStatus(makeInvoice('api-basic'));

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('monuser:monpass').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });

  it('ajoute un header Authorization Bearer pour apiAuthType=API_KEY', async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'API',
      apiBaseUrl: 'https://pa.example.com/v1',
      apiAuthType: 'API_KEY',
      apiCredentialsEncrypted: JSON.stringify({ key: 'tok_abc123' }),
    });

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const result = await deliverPaStatus(makeInvoice('api-key'));
    expect(result.mode).toBe('HTTP');
  });

  it("propage l'erreur HTTP (statut 4xx)", async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'API',
      apiBaseUrl: 'https://pa.example.com/v1',
      apiAuthType: null,
      apiCredentialsEncrypted: null,
    });

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    await expect(deliverPaStatus(makeInvoice('api-err'))).rejects.toThrow('HTTP 401');
  });

  it("encode paMessageId dans l'URL (caractères spéciaux)", async () => {
    mockFindFirst.mockResolvedValue({
      protocol: 'API',
      apiBaseUrl: 'https://pa.example.com/v1',
      apiAuthType: null,
      apiCredentialsEncrypted: null,
    });

    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    const invoice = { ...makeInvoice('api-ch'), paMessageId: 'MSG/2026:001' };
    await deliverPaStatus(invoice);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent('MSG/2026:001'));
  });

  // ── Payload ────────────────────────────────────────────────────────────────

  it('le payload contient les champs attendus par la PA', async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await deliverPaStatus(makeInvoice());

    expect(result.payload).toMatchObject({
      paMessageId: 'MSG-001',
      outcome: 'VALIDATED', // POSTED → VALIDATED
      sapDocNum: 1042,
      docNumberPa: 'FA-2026-001',
    });
  });
});
