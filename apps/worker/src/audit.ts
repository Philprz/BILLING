import { createAuditLogBestEffort } from '@pa-sap-bridge/database';

export async function auditIngestion(
  outcome: 'OK' | 'ERROR',
  entityId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await createAuditLogBestEffort({
    sapUser: null,
    action: 'FETCH_PA',
    entityType: 'INVOICE',
    entityId,
    payloadAfter: detail,
    outcome,
    errorMessage: outcome === 'ERROR' && detail.error ? String(detail.error) : null,
  });
}
