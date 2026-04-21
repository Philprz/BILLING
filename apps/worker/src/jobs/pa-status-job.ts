/**
 * Job de retour de statut vers la PA avec retry automatique.
 *
 * Stratégie :
 * - Cherche toutes les factures POSTED ou REJECTED sans paStatusSentAt
 * - Vérifie le nombre de tentatives échouées dans l'audit log (max 3)
 * - Tente l'envoi ; sur erreur : crée un log ERROR et laisse pour le prochain cycle
 * - Après 3 échecs : abandonne silencieusement (laissé à la main de l'opérateur)
 *
 * Les délais entre les tentatives résultent naturellement de POLL_INTERVAL_MS.
 */

import fs from 'fs';
import path from 'path';
import {
  buildPaStatusPayload,
  computeNextRetryAt,
  createAuditLogBestEffort,
  getPaStatusRetryPolicy,
  isPaStatusRetryDue,
  prisma,
} from '@pa-sap-bridge/database';

// Même chemin que dans pa-status.service.ts (API), sans importer le service
// car le worker n'a pas accès au module api.
const REPO_ROOT     = path.resolve(__dirname, '..', '..', '..', '..');

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[PaStatusJob][${new Date().toISOString()}][${level}] ${msg}`);
}

function getStatusOutPath(): string {
  return process.env.STATUS_OUT_PATH
    ? path.resolve(process.env.STATUS_OUT_PATH)
    : path.join(REPO_ROOT, 'data', 'status-out');
}

async function writeStatusFile(invoice: {
  paMessageId: string;
  docNumberPa: string;
  paSource:    string;
  status:      string;
  statusReason: string | null;
  sapDocEntry:  number | null;
  sapDocNum:    number | null;
}): Promise<{ payload: ReturnType<typeof buildPaStatusPayload>; targetFile: string }> {
  const statusOut = getStatusOutPath();

  if (!fs.existsSync(statusOut)) {
    fs.mkdirSync(statusOut, { recursive: true });
  }

  const payload = buildPaStatusPayload(invoice);

  const safeMsgId = invoice.paMessageId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  const filename  = `status_${safeMsgId}_${Date.now()}.json`;
  const targetFile = path.join(statusOut, filename);
  fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf-8');

  return { payload, targetFile };
}

export async function runPaStatusJob(): Promise<void> {
  const retryPolicy = getPaStatusRetryPolicy();
  const pending = await prisma.invoice.findMany({
    where: {
      paStatusSentAt: null,
      status: { in: ['POSTED', 'REJECTED'] },
    },
    select: {
      id: true, paMessageId: true, docNumberPa: true, paSource: true,
      status: true, statusReason: true, sapDocEntry: true, sapDocNum: true,
    },
  });

  if (pending.length === 0) return;
  log('INFO', `${pending.length} facture(s) en attente de retour statut PA.`);

  for (const invoice of pending) {
    const failures = await prisma.auditLog.findMany({
      where: {
        entityId: invoice.id,
        action:   'SEND_STATUS_PA',
        outcome:  'ERROR',
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });

    const failCount = failures.length;
    const lastFailureAt = failures[0]?.occurredAt ?? null;

    if (failCount >= retryPolicy.maxRetries) {
      log('WARN', `Facture ${invoice.id} : ${retryPolicy.maxRetries} tentatives épuisées — abandon.`);
      continue;
    }

    if (!isPaStatusRetryDue(failCount, lastFailureAt)) {
      const nextRetryAt = computeNextRetryAt(failCount, lastFailureAt ?? new Date());
      log('INFO', `Facture ${invoice.id} : retry différé jusqu'à ${nextRetryAt?.toISOString() ?? 'n/a'}.`);
      continue;
    }

    try {
      const sent = await writeStatusFile(invoice);

      await prisma.invoice.update({
        where: { id: invoice.id },
        data:  { paStatusSentAt: new Date() },
      });

      await createAuditLogBestEffort({
        action: 'SEND_STATUS_PA',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'OK',
        payloadBefore: {
          status: invoice.status,
          paStatusSentAt: null,
        },
        payloadAfter: {
          ...sent.payload,
          attempt: failCount + 1,
          maxRetries: retryPolicy.maxRetries,
          deliveryMode: 'FILE_STUB',
          targetFile: sent.targetFile,
        },
      });

      log('INFO', `Statut envoyé OK pour facture ${invoice.id} (tentative ${failCount + 1}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = failCount + 1;
      const nextRetryAt = computeNextRetryAt(attempt, new Date());

      await createAuditLogBestEffort({
        action: 'SEND_STATUS_PA',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'ERROR',
        errorMessage: message,
        payloadBefore: {
          status: invoice.status,
          paStatusSentAt: null,
        },
        payloadAfter: {
          ...buildPaStatusPayload(invoice),
          attempt,
          maxRetries: retryPolicy.maxRetries,
          retryScheduled: attempt < retryPolicy.maxRetries,
          nextRetryAt: nextRetryAt?.toISOString() ?? null,
        },
      });

      log('ERROR', `Facture ${invoice.id} : échec envoi statut (tentative ${attempt}/${retryPolicy.maxRetries}) — ${message}`);
    }
  }
}
