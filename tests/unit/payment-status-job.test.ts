/**
 * Tests unitaires — Partie B : job de suivi U_NOVA_Statut (payment-status-job).
 *
 * Couvre :
 *   - sélection des factures intégrées non SOLDE ;
 *   - mapping état SAP → échelle + consolidation « le plus avancé gagne » (PA > SAP) ;
 *   - PATCH UDF uniquement si la valeur change (et seulement en politique real) ;
 *   - aucune écriture si la valeur est inchangée.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pa-sap-bridge/database', async () => {
  const actual =
    await vi.importActual<typeof import('@pa-sap-bridge/database')>('@pa-sap-bridge/database');
  return {
    ...actual, // garde la logique réelle (mapping + consolidation)
    prisma: { invoice: { findMany: vi.fn(), update: vi.fn() } },
    createAuditLogBestEffort: vi.fn(),
  };
});

vi.mock('../../apps/worker/src/sap/sap-worker-client', () => ({
  fetchInvoiceSettlement: vi.fn(),
  ensureUdfNovaStatut: vi.fn(),
  patchUdfNovaStatut: vi.fn(),
  SapWorkerError: class SapWorkerError extends Error {},
}));

import { prisma } from '@pa-sap-bridge/database';
import {
  fetchInvoiceSettlement,
  ensureUdfNovaStatut,
  patchUdfNovaStatut,
} from '../../apps/worker/src/sap/sap-worker-client';
import { runPaymentStatusJob } from '../../apps/worker/src/jobs/payment-status-job';

const db = prisma as unknown as {
  invoice: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
const settlement = vi.mocked(fetchInvoiceSettlement);
const patch = vi.mocked(patchUdfNovaStatut);
const ensure = vi.mocked(ensureUdfNovaStatut);

const ORIGINAL_POLICY = process.env.SAP_POST_POLICY;

beforeEach(() => {
  vi.clearAllMocks();
  db.invoice.update.mockResolvedValue({});
  ensure.mockResolvedValue({ alreadyExists: true });
  process.env.SAP_POST_POLICY = 'real';
});

afterEach(() => {
  process.env.SAP_POST_POLICY = ORIGINAL_POLICY;
});

describe('runPaymentStatusJob', () => {
  it('sélectionne les factures intégrées (POSTED/LINKED) avec poste SAP, non SOLDE', async () => {
    db.invoice.findMany.mockResolvedValue([]);
    await runPaymentStatusJob();
    const where = db.invoice.findMany.mock.calls[0][0].where;
    expect(where.sapDocEntry).toEqual({ not: null });
    expect(where.status).toEqual({ in: ['POSTED', 'LINKED'] });
    expect(where.OR).toEqual([
      { novaPaymentStatus: null },
      { novaPaymentStatus: { not: 'SOLDE' } },
    ]);
  });

  it('PATCH l’UDF + met à jour le miroir quand l’état change (NON_PAYE → PARTIEL)', async () => {
    db.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', sapDocEntry: 433, novaPaymentStatus: 'NON_PAYE', paPaymentStatus: null },
    ]);
    settlement.mockResolvedValue({
      docEntry: 433,
      docTotal: 1000,
      paidToDate: 400,
      documentStatus: 'bost_Open',
    });

    await runPaymentStatusJob();

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(433, 'PARTIEL');
    expect(db.invoice.update).toHaveBeenCalledTimes(1);
    const data = db.invoice.update.mock.calls[0][0].data;
    expect(data.novaPaymentStatus).toBe('PARTIEL');
    expect(data.novaPaymentStatusSource).toBe('SAP');
  });

  it('n’écrit RIEN si la valeur est inchangée (pas de PATCH, pas d’update)', async () => {
    db.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', sapDocEntry: 433, novaPaymentStatus: 'PARTIEL', paPaymentStatus: null },
    ]);
    settlement.mockResolvedValue({
      docEntry: 433,
      docTotal: 1000,
      paidToDate: 400,
      documentStatus: 'bost_Open',
    });

    await runPaymentStatusJob();

    expect(patch).not.toHaveBeenCalled();
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it('consolidation : le candidat PA plus avancé que SAP gagne (source PA)', async () => {
    db.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', sapDocEntry: 433, novaPaymentStatus: 'NON_PAYE', paPaymentStatus: 'PAYE' },
    ]);
    settlement.mockResolvedValue({
      docEntry: 433,
      docTotal: 1000,
      paidToDate: 0,
      documentStatus: 'bost_Open', // SAP = NON_PAYE
    });

    await runPaymentStatusJob();

    expect(patch).toHaveBeenCalledWith(433, 'PAYE');
    const data = db.invoice.update.mock.calls[0][0].data;
    expect(data.novaPaymentStatus).toBe('PAYE');
    expect(data.novaPaymentStatusSource).toBe('PA');
  });

  it('en politique simulate : pas de PATCH SAP, mais miroir base mis à jour', async () => {
    process.env.SAP_POST_POLICY = 'simulate';
    db.invoice.findMany.mockResolvedValue([
      { id: 'inv-1', sapDocEntry: 433, novaPaymentStatus: 'NON_PAYE', paPaymentStatus: null },
    ]);
    settlement.mockResolvedValue({
      docEntry: 433,
      docTotal: 1000,
      paidToDate: 1000,
      documentStatus: 'bost_Close', // SOLDE
    });

    await runPaymentStatusJob();

    expect(patch).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(db.invoice.update).toHaveBeenCalledTimes(1);
    expect(db.invoice.update.mock.calls[0][0].data.novaPaymentStatus).toBe('SOLDE');
  });
});
