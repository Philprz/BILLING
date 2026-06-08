/**
 * Tests unitaires — job de retour de statut PA (apps/worker/src/jobs/pa-status-job.ts).
 *
 * Couvre l'éligibilité du statut SUPERSEDED (originale remplacée par une rectificative 384) :
 *   - une originale SUPERSEDED non encore livrée (paStatusSentAt = null) est SÉLECTIONNÉE ;
 *   - après envoi réussi, paStatusSentAt est posé → pas de second envoi (idempotence) ;
 *   - l'issue dérivée livrée est REJECTED (motif = statusReason).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Prisma + audit mockés ; le reste (buildPaStatusPayload, policy, retry) reste réel.
vi.mock('@pa-sap-bridge/database', async () => {
  const actual =
    await vi.importActual<typeof import('@pa-sap-bridge/database')>('@pa-sap-bridge/database');
  return {
    ...actual,
    prisma: {
      invoice: { findMany: vi.fn(), update: vi.fn() },
      auditLog: { findMany: vi.fn() },
    },
    createAuditLogBestEffort: vi.fn(),
  };
});

// Livraison PA mockée (pas d'I/O réseau/fichier).
vi.mock('../../apps/worker/src/delivery/pa-status-delivery', () => ({
  deliverPaStatus: vi.fn(),
}));

import { prisma } from '@pa-sap-bridge/database';
import { deliverPaStatus } from '../../apps/worker/src/delivery/pa-status-delivery';
import { runPaStatusJob } from '../../apps/worker/src/jobs/pa-status-job';

type Mocked = {
  invoice: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  auditLog: { findMany: ReturnType<typeof vi.fn> };
};
const db = prisma as unknown as Mocked;
const deliver = deliverPaStatus as unknown as ReturnType<typeof vi.fn>;

const supersededInvoice = {
  id: 'orig-id',
  paMessageId: 'MSG-ORIG',
  docNumberPa: 'DOC-ORIG-42',
  paSource: 'CANAL-A',
  status: 'SUPERSEDED',
  statusReason: 'Remplacée par rectificative DOC-384',
  sapDocEntry: null,
  sapDocNum: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.auditLog.findMany.mockResolvedValue([]); // aucun échec antérieur
  db.invoice.update.mockResolvedValue({});
});

describe('runPaStatusJob — éligibilité SUPERSEDED (clôture PA d’une originale remplacée par une 384)', () => {
  it('sélectionne les statuts POSTED / REJECTED / SUPERSEDED non encore livrés', async () => {
    db.invoice.findMany.mockResolvedValue([]);

    await runPaStatusJob();

    expect(db.invoice.findMany).toHaveBeenCalledTimes(1);
    const where = db.invoice.findMany.mock.calls[0][0].where;
    expect(where.paStatusSentAt).toBeNull();
    expect(where.status).toEqual({ in: ['POSTED', 'REJECTED', 'SUPERSEDED'] });
  });

  it('livre l’issue REJECTED puis pose paStatusSentAt (pas de second envoi)', async () => {
    db.invoice.findMany.mockResolvedValue([supersededInvoice]);
    deliver.mockResolvedValue({
      payload: {
        paMessageId: 'MSG-ORIG',
        docNumberPa: 'DOC-ORIG-42',
        paSource: 'CANAL-A',
        outcome: 'REJECTED',
        reason: 'Remplacée par rectificative DOC-384',
        sapDocEntry: null,
        sapDocNum: null,
        sentAt: '2026-06-05T00:00:00.000Z',
      },
      mode: 'LOCAL',
      target: '/tmp/status-out',
    });

    await runPaStatusJob();

    // La livraison reçoit bien l'originale SUPERSEDED…
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({
      id: 'orig-id',
      status: 'SUPERSEDED',
      statusReason: 'Remplacée par rectificative DOC-384',
    });

    // …et l'envoi est marqué une fois (idempotence : prochain run ne la resélectionne plus).
    expect(db.invoice.update).toHaveBeenCalledTimes(1);
    const updateArg = db.invoice.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'orig-id' });
    expect(updateArg.data.paStatusSentAt).toBeInstanceOf(Date);
  });
});
