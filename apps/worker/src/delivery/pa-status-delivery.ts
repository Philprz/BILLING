/**
 * Livraison du statut PA vers la source d'origine (CDC §9) — version worker.
 *
 * Logique identique à apps/api/src/services/pa-status-delivery.ts.
 * Maintenu séparément car le worker et l'API sont des packages distincts.
 */

import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { buildPaStatusPayload, prisma } from '@pa-sap-bridge/database';

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
    // credentials non JSON — ignoré
  }
  return {};
}

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

export async function deliverPaStatus(invoice: InvoiceInput): Promise<DeliveryResult> {
  const payload = buildPaStatusPayload(invoice);

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

  const target = deliverFileStub(invoice, payload);
  return { mode: 'FILE_STUB', target, payload };
}
