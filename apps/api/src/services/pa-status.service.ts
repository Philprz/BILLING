import fs from 'fs';
import path from 'path';
import { buildPaStatusPayload, type PaStatusPayload } from '@pa-sap-bridge/database';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export interface SendPaStatusResult {
  payload: PaStatusPayload;
  deliveryMode: 'FILE_STUB';
  targetFile: string;
}

function getStatusOutPath(): string {
  return process.env.STATUS_OUT_PATH
    ? path.resolve(process.env.STATUS_OUT_PATH)
    : path.join(REPO_ROOT, 'data', 'status-out');
}

export async function sendPaStatus(invoice: {
  id:           string;
  paMessageId:  string;
  docNumberPa:  string;
  paSource:     string;
  status:       string;
  statusReason: string | null;
  sapDocEntry:  number | null;
  sapDocNum:    number | null;
}): Promise<SendPaStatusResult> {
  const payload = buildPaStatusPayload(invoice);
  const statusOutPath = getStatusOutPath();

  if (!fs.existsSync(statusOutPath)) {
    fs.mkdirSync(statusOutPath, { recursive: true });
  }

  const safeMsgId = invoice.paMessageId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  const filename  = `status_${safeMsgId}_${Date.now()}.json`;
  const filePath  = path.join(statusOutPath, filename);

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  return {
    payload,
    deliveryMode: 'FILE_STUB',
    targetFile: filePath,
  };
}
