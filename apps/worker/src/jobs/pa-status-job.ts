/**
 * Job de retour de statut vers la PA avec retry automatique (CDC §9).
 *
 * Stratégie de livraison :
 *   - Canal API  → POST HTTP vers {apiBaseUrl}/invoices/{paMessageId}/status
 *   - Canal SFTP → dépôt JSON dans remotePathOut
 *   - Pas de canal (MANUAL_UPLOAD, LOCAL_INBOX) → fichier local
 *
 * Retry exponentiel via isPaStatusRetryDue (1 min, 5 min, 30 min, 2 h, 12 h).
 * Abandon silencieux après maxRetries tentatives échouées.
 */

import {
  buildPaStatusPayload,
  computeNextRetryAt,
  createAuditLogBestEffort,
  getPaStatusRetryPolicy,
  isPaStatusRetryDue,
  prisma,
} from '@pa-sap-bridge/database';
import { deliverPaStatus } from '../delivery/pa-status-delivery';

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[PaStatusJob][${new Date().toISOString()}][${level}] ${msg}`);
}

export async function runPaStatusJob(): Promise<void> {
  const retryPolicy = getPaStatusRetryPolicy();
  const pending = await prisma.invoice.findMany({
    where: {
      paStatusSentAt: null,
      status: { in: ['POSTED', 'REJECTED'] },
    },
    select: {
      id: true,
      paMessageId: true,
      docNumberPa: true,
      paSource: true,
      status: true,
      statusReason: true,
      sapDocEntry: true,
      sapDocNum: true,
    },
  });

  if (pending.length === 0) return;
  log('INFO', `${pending.length} facture(s) en attente de retour statut PA.`);

  for (const invoice of pending) {
    const failures = await prisma.auditLog.findMany({
      where: { entityId: invoice.id, action: 'SEND_STATUS_PA', outcome: 'ERROR' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });

    const failCount = failures.length;
    const lastFailAt = failures[0]?.occurredAt ?? null;

    if (failCount >= retryPolicy.maxRetries) {
      log(
        'WARN',
        `Facture ${invoice.id} : ${retryPolicy.maxRetries} tentatives épuisées — abandon.`,
      );
      continue;
    }

    if (!isPaStatusRetryDue(failCount, lastFailAt)) {
      const next = computeNextRetryAt(failCount, lastFailAt ?? new Date());
      log('INFO', `Facture ${invoice.id} : retry différé jusqu'à ${next?.toISOString() ?? 'n/a'}.`);
      continue;
    }

    try {
      const result = await deliverPaStatus({
        id: invoice.id,
        paMessageId: invoice.paMessageId,
        docNumberPa: invoice.docNumberPa,
        paSource: invoice.paSource,
        status: invoice.status,
        statusReason: invoice.statusReason,
        sapDocEntry: invoice.sapDocEntry,
        sapDocNum: invoice.sapDocNum,
      });

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { paStatusSentAt: new Date() },
      });

      await createAuditLogBestEffort({
        action: 'SEND_STATUS_PA',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'OK',
        payloadBefore: { status: invoice.status, paStatusSentAt: null },
        payloadAfter: {
          ...result.payload,
          attempt: failCount + 1,
          maxRetries: retryPolicy.maxRetries,
          deliveryMode: result.mode,
          target: result.target,
        },
      });

      log(
        'INFO',
        `Statut envoyé [${result.mode}] → ${result.target} (tentative ${failCount + 1}).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = failCount + 1;
      const next = computeNextRetryAt(attempt, new Date());

      await createAuditLogBestEffort({
        action: 'SEND_STATUS_PA',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'ERROR',
        errorMessage: message,
        payloadBefore: { status: invoice.status, paStatusSentAt: null },
        payloadAfter: {
          ...buildPaStatusPayload(invoice),
          attempt,
          maxRetries: retryPolicy.maxRetries,
          retryScheduled: attempt < retryPolicy.maxRetries,
          nextRetryAt: next?.toISOString() ?? null,
        },
      });

      log(
        'ERROR',
        `Facture ${invoice.id} : échec envoi (${attempt}/${retryPolicy.maxRetries}) — ${message}`,
      );
    }
  }
}
