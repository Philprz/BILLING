/**
 * Livraison du statut PA vers la source d'origine (CDC §9).
 *
 * Stratégie selon le canal PA :
 *   - protocol = 'API'  → POST HTTP vers {apiBaseUrl}/invoices/{paMessageId}/status
 *   - protocol = 'SFTP' → dépôt JSON dans remotePathOut du serveur SFTP
 *   - pas de canal (MANUAL_UPLOAD, LOCAL_INBOX) → fichier local (stub)
 */

import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { buildPaStatusPayload, prisma } from '@pa-sap-bridge/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DeliveryMode = 'HTTP' | 'SFTP' | 'FILE_STUB';

export interface DeliveryResult {
  mode: DeliveryMode;
  target: string;
  payload: ReturnType<typeof buildPaStatusPayload>;
}

interface InvoiceInput {
  id: string;
  paMessageId: string;
  docNumberPa: string;
  paSource: string;
  status: string;
  statusReason: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeId(paMessageId: string): string {
  return paMessageId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
}

function getStatusOutPath(): string {
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return process.env.STATUS_OUT_PATH
    ? path.resolve(process.env.STATUS_OUT_PATH)
    : path.join(root, 'data', 'status-out');
}

function buildAuthHeaders(
  authType: string | null,
  credentials: string | null,
): Record<string, string> {
  if (!credentials) return {};
  try {
    const creds = JSON.parse(credentials) as Record<string, string>;
    if (authType === 'BASIC' && creds.user && creds.password) {
      const token = Buffer.from(`${creds.user}:${creds.password}`).toString('base64');
      return { Authorization: `Basic ${token}` };
    }
    if (authType === 'API_KEY' && creds.key) {
      return { Authorization: `Bearer ${creds.key}` };
    }
  } catch {
    // credentials non JSON — on ignore
  }
  return {};
}

// ─── Livraison HTTP ───────────────────────────────────────────────────────────

async function deliverHttp(
  apiBaseUrl: string,
  apiAuthType: string | null,
  apiCredentials: string | null,
  invoice: InvoiceInput,
  payload: ReturnType<typeof buildPaStatusPayload>,
): Promise<string> {
  const base = apiBaseUrl.replace(/\/$/, '');
  const url = `${base}/invoices/${encodeURIComponent(invoice.paMessageId)}/status`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(apiAuthType, apiCredentials),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }

  return url;
}

// ─── Livraison SFTP ───────────────────────────────────────────────────────────

async function deliverSftp(
  host: string,
  port: number,
  user: string,
  password: string,
  remotePathOut: string,
  invoice: InvoiceInput,
  payload: ReturnType<typeof buildPaStatusPayload>,
): Promise<string> {
  const sftp = new SftpClient();
  const filename = `status_${safeId(invoice.paMessageId)}_${Date.now()}.json`;
  const remotePath = `${remotePathOut.replace(/\/$/, '')}/${filename}`;

  try {
    await sftp.connect({ host, port, username: user, password });
    await sftp.put(Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'), remotePath);
  } finally {
    await sftp.end().catch(() => {});
  }

  return remotePath;
}

// ─── Livraison fichier local (stub / fallback) ────────────────────────────────

function deliverFileStub(
  invoice: InvoiceInput,
  payload: ReturnType<typeof buildPaStatusPayload>,
): string {
  const dir = getStatusOutPath();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `status_${safeId(invoice.paMessageId)}_${Date.now()}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

export async function deliverPaStatus(invoice: InvoiceInput): Promise<DeliveryResult> {
  const payload = buildPaStatusPayload(invoice);

  // Cherche le canal PA correspondant à la source de la facture
  const channel = await prisma.paChannel.findFirst({
    where: { name: invoice.paSource },
    select: {
      protocol: true,
      apiBaseUrl: true,
      apiAuthType: true,
      apiCredentialsEncrypted: true,
      host: true,
      port: true,
      user: true,
      passwordEncrypted: true,
      remotePathOut: true,
    },
  });

  if (channel?.protocol === 'API' && channel.apiBaseUrl) {
    const target = await deliverHttp(
      channel.apiBaseUrl,
      channel.apiAuthType ?? null,
      channel.apiCredentialsEncrypted ?? null,
      invoice,
      payload,
    );
    return { mode: 'HTTP', target, payload };
  }

  if (channel?.protocol === 'SFTP' && channel.host && channel.user && channel.remotePathOut) {
    const target = await deliverSftp(
      channel.host,
      channel.port ?? 22,
      channel.user,
      channel.passwordEncrypted ?? '',
      channel.remotePathOut,
      invoice,
      payload,
    );
    return { mode: 'SFTP', target, payload };
  }

  // Pas de canal PA actif → fichier local (MANUAL_UPLOAD, LOCAL_INBOX, canal supprimé)
  const target = deliverFileStub(invoice, payload);
  return { mode: 'FILE_STUB', target, payload };
}
