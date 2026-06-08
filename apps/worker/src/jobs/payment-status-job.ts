/**
 * Niveau payé (matrice S/B 2) — Partie B : job de suivi U_NOVA_Statut.
 *
 * Pour chaque facture intégrée non encore `SOLDE`, le job :
 *   1. lit l'état de règlement SAP (poll SL : DocTotal/PaidToDate/DocumentStatus) ;
 *   2. mappe SAP → échelle (NON_PAYE/PARTIEL/SOLDE) ;
 *   3. consolide avec le candidat PA (`paPaymentStatus`, cycle de vie réforme) selon
 *      « l'état le plus avancé gagne » (NON_PAYE<PROGRAMME<PARTIEL<PAYE<SOLDE) ;
 *   4. si la valeur change : réécrit l'UDF `U_NOVA_Statut` côté SAP (PATCH de SUIVI,
 *      jamais un paiement) et met à jour le miroir base (source + horodatage).
 *
 * Sécurité : ce job ne crée AUCUN paiement. Le seul write SAP est le PATCH de l'UDF,
 * borné par SAP_POST_POLICY (real → PATCH ; simulate/disabled → pas de write SAP, le
 * miroir base est tout de même mis à jour pour l'affichage NOVA).
 */

import {
  prisma,
  createAuditLogBestEffort,
  mapSapSettlementToNovaStatut,
  mapPaLifecycleToNovaStatut,
  consolidateNovaStatut,
  type NovaStatutCandidate,
} from '@pa-sap-bridge/database';
import {
  fetchInvoiceSettlement,
  ensureUdfNovaStatut,
  patchUdfNovaStatut,
  SapWorkerError,
} from '../sap/sap-worker-client';

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[PaymentStatusJob][${new Date().toISOString()}][${level}] ${msg}`);
}

function effectivePolicy(): 'real' | 'simulate' | 'disabled' {
  const p = (process.env.SAP_POST_POLICY ?? 'real').trim().toLowerCase();
  return p === 'simulate' || p === 'disabled' ? p : 'real';
}

export async function runPaymentStatusJob(): Promise<void> {
  // Factures intégrées (POSTED/LINKED) avec un poste SAP, pas encore SOLDE.
  const pending = await prisma.invoice.findMany({
    where: {
      sapDocEntry: { not: null },
      status: { in: ['POSTED', 'LINKED'] },
      OR: [{ novaPaymentStatus: null }, { novaPaymentStatus: { not: 'SOLDE' } }],
    },
    select: {
      id: true,
      sapDocEntry: true,
      novaPaymentStatus: true,
      paPaymentStatus: true,
    },
  });

  if (pending.length === 0) return;
  log('INFO', `${pending.length} facture(s) à évaluer pour le niveau payé.`);

  const policy = effectivePolicy();

  // Garantir l'UDF de suivi (idempotent) — uniquement si on écrira réellement.
  if (policy === 'real') {
    try {
      await ensureUdfNovaStatut();
    } catch (err) {
      log(
        'WARN',
        `UDF U_NOVA_Statut non garantie : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const invoice of pending) {
    if (invoice.sapDocEntry === null) continue;
    try {
      const settlement = await fetchInvoiceSettlement(invoice.sapDocEntry);
      if (!settlement) {
        log(
          'WARN',
          `Poste SAP DocEntry=${invoice.sapDocEntry} introuvable (facture ${invoice.id}).`,
        );
        continue;
      }

      const now = new Date();
      const sapValue = mapSapSettlementToNovaStatut({
        docTotal: settlement.docTotal,
        paidToDate: settlement.paidToDate,
        documentStatus: settlement.documentStatus,
      });
      const candidates: NovaStatutCandidate[] = [{ value: sapValue, source: 'SAP', at: now }];

      const paValue = mapPaLifecycleToNovaStatut(invoice.paPaymentStatus);
      if (paValue) candidates.push({ value: paValue, source: 'PA', at: now });

      const consolidated = consolidateNovaStatut(candidates);
      if (!consolidated) continue;

      // Pas de changement → aucune écriture (ni SAP, ni base).
      if (consolidated.value === invoice.novaPaymentStatus) continue;

      // Réécriture UDF SAP (PATCH de suivi) — uniquement en politique real.
      let sapPatched = false;
      if (policy === 'real') {
        await patchUdfNovaStatut(invoice.sapDocEntry, consolidated.value);
        sapPatched = true;
      }

      // Miroir base (affichage NOVA) — toujours mis à jour.
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          novaPaymentStatus: consolidated.value,
          novaPaymentStatusSource: consolidated.source,
          novaPaymentStatusAt: consolidated.at,
        },
      });

      await createAuditLogBestEffort({
        action: 'POST_SAP',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'OK',
        payloadBefore: { novaPaymentStatus: invoice.novaPaymentStatus },
        payloadAfter: {
          stage: 'NOVA_STATUT_UPDATED',
          novaPaymentStatus: consolidated.value,
          source: consolidated.source,
          sapPatched,
          policy,
          sapDocEntry: invoice.sapDocEntry,
          settlement: {
            docTotal: settlement.docTotal,
            paidToDate: settlement.paidToDate,
            documentStatus: settlement.documentStatus,
          },
        },
      });

      log(
        'INFO',
        `Facture ${invoice.id} : ${invoice.novaPaymentStatus ?? 'null'} → ${consolidated.value} (source ${consolidated.source}, SAP ${sapPatched ? 'PATCH' : 'skip'}).`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const httpStatus = err instanceof SapWorkerError ? err.httpStatus : undefined;
      log(
        'ERROR',
        `Facture ${invoice.id} : ${message}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`,
      );
      await createAuditLogBestEffort({
        action: 'POST_SAP',
        entityType: 'INVOICE',
        entityId: invoice.id,
        outcome: 'ERROR',
        errorMessage: message,
        payloadAfter: { stage: 'NOVA_STATUT_ERROR', sapDocEntry: invoice.sapDocEntry },
      });
    }
  }
}
