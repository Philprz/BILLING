/**
 * F3 — Déduction de l'acompte (DownPaymentsToDraw) à l'intégration SAP B1.
 *
 * Contexte (audit 2026-06-05, écart P0) : une facture définitive après acompte
 * (`direction = INVOICE` portant un `prepaidAmount` BT-113) doit, à l'intégration
 * en `PurchaseInvoices`, **tirer** l'acompte SAP correspondant via la collection
 * `DownPaymentsToDraw`. Sans ce tirage, le TTC est posté plein et l'acompte est
 * compté deux fois (une fois en 386 `PurchaseDownPayments`, une fois dans la définitive).
 *
 * Clé de rapprochement (décision verrouillée, BT-25 — pas de PO/BT-13 parsé) :
 *   l'acompte = facture `ADVANCE_INVOICE`, même `supplierPaIdentifier`,
 *   `docNumberPa === correctedInvoiceRef` de la définitive, statut `POSTED`
 *   (donc `sapDocEntry` renseigné = le DocEntry de l'acompte SAP à tirer).
 *
 * Si l'acompte n'est PAS rapprochable, on **bloque** l'intégration (jamais de post
 * à TTC plein) : c'est l'appelant qui passe la facture en TO_REVIEW avec le motif.
 */

import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';

/** Entrée minimale nécessaire à la détection / résolution d'acompte. */
export interface DownPaymentResolveInput {
  direction: string;
  prepaidAmount: Prisma.Decimal | number | null;
  correctedInvoiceRef: string | null;
  supplierPaIdentifier: string;
}

/** Tirage d'acompte résolu, prêt pour le payload `DownPaymentsToDraw`. */
export type DownPaymentDraw =
  | { ok: true; docEntry: number; amountToDraw: number }
  | { ok: false; reason: string };

/**
 * Détecte un F3 : facture définitive (`INVOICE`) portant un acompte (`prepaidAmount > 0`).
 * (Décision 1 du prompt.)
 */
export function isFinalInvoiceWithDownPayment(invoice: {
  direction: string;
  prepaidAmount: Prisma.Decimal | number | null;
}): boolean {
  if (invoice.direction !== 'INVOICE') return false;
  if (invoice.prepaidAmount === null || invoice.prepaidAmount === undefined) return false;
  return Number(invoice.prepaidAmount) > 0;
}

/** Acompte 386 rapproché (POSTED, DocEntry SAP présent), prêt à être tiré. */
interface ResolvedAdvance {
  id: string;
  sapDocEntry: number;
  totalInclTax: number;
}

/**
 * Recherche l'acompte 386 (`ADVANCE_INVOICE`, `POSTED`) rapprochable par la clé
 * BT-25 (`correctedInvoiceRef` → `docNumberPa`) + `supplierPaIdentifier`, et
 * contrôle qu'il a bien un `sapDocEntry`. Source unique du rapprochement,
 * partagée par F3 (tirage) et 503 (contre-passation).
 *
 * Retourne `{ ok: true, advance }` ou `{ ok: false, reason }` (motif lisible).
 */
async function findPostedAdvance(
  supplierPaIdentifier: string,
  correctedInvoiceRef: string | null,
): Promise<{ ok: true; advance: ResolvedAdvance } | { ok: false; reason: string }> {
  const ref = correctedInvoiceRef?.trim();
  if (!ref) {
    return {
      ok: false,
      reason:
        "Référence de la facture d'acompte (BT-25) absente : impossible de rapprocher l'acompte 386.",
    };
  }

  const advance = await prisma.invoice.findFirst({
    where: {
      direction: 'ADVANCE_INVOICE',
      supplierPaIdentifier,
      docNumberPa: ref,
      status: 'POSTED',
    },
    orderBy: { receivedAt: 'desc' },
    select: { id: true, sapDocEntry: true, totalInclTax: true, status: true },
  });

  if (!advance) {
    return {
      ok: false,
      reason: `Acompte 386 introuvable (ou non intégré) pour la référence "${ref}" — aucune facture d'acompte POSTED ne correspond pour ce fournisseur.`,
    };
  }

  if (advance.sapDocEntry === null) {
    return {
      ok: false,
      reason: `Acompte 386 "${ref}" non encore intégré dans SAP (DocEntry absent).`,
    };
  }

  return {
    ok: true,
    advance: {
      id: advance.id,
      sapDocEntry: advance.sapDocEntry,
      totalInclTax: Number(advance.totalInclTax),
    },
  };
}

/**
 * Résout l'acompte SAP à tirer pour une facture définitive F3.
 *
 * Retourne `{ ok: true, docEntry, amountToDraw }` si l'acompte est rapprochable,
 * sinon `{ ok: false, reason }` avec un motif lisible (jamais de post à TTC plein).
 */
export async function resolveDownPaymentDraw(
  invoice: DownPaymentResolveInput,
): Promise<DownPaymentDraw> {
  const prepaid = invoice.prepaidAmount === null ? 0 : Number(invoice.prepaidAmount);
  if (!(prepaid > 0)) {
    return {
      ok: false,
      reason: "Montant d'acompte (BT-113) absent ou nul sur la facture définitive.",
    };
  }

  const found = await findPostedAdvance(invoice.supplierPaIdentifier, invoice.correctedInvoiceRef);
  if (!found.ok) return found;
  const { advance } = found;

  // Contrôle de base : on ne tire jamais plus que le montant de l'acompte.
  // (SAP rejette de toute façon un tirage > montant ouvert ; on bloque en amont
  // avec un motif lisible plutôt que de laisser SAP renvoyer une erreur opaque.)
  if (advance.totalInclTax > 0 && prepaid > advance.totalInclTax + 0.01) {
    return {
      ok: false,
      reason: `Montant d'acompte incohérent : ${prepaid.toFixed(2)} € à déduire > montant de l'acompte 386 (${advance.totalInclTax.toFixed(2)} €).`,
    };
  }

  return { ok: true, docEntry: advance.sapDocEntry, amountToDraw: prepaid };
}

// ─── 503 — Contre-passation de l'acompte (avoir d'acompte) ────────────────────
//
// Contexte (audit 2026-06-05, écart P1) : un 503 (`direction = ADVANCE_CREDIT_NOTE`)
// doit réduire — partiellement OU totalement — l'acompte 386 d'origine, et non
// créer un avoir d'achat générique. Mécanisme SAP confirmé LIVE (lecture seule,
// $metadata + GET, voir scripts/inspect-creditnote-downpayment.ts) :
//   la collection `DownPaymentsToDraw` ({ DocEntry, AmountToDraw:Edm.Double }) est
//   exposée sur Document, donc sur `PurchaseCreditNotes` → un avoir d'achat peut
//   « tirer » l'acompte d'un montant variable = celui porté par le 503 (partiel OK).
//
// Le rapprochement réutilise strictement la clé F3 (BT-25 + fournisseur, acompte
// POSTED). Le montant à contre-passer = `totalInclTax` du 503 (valeur absolue —
// les avoirs peuvent être stockés en magnitude). Si l'acompte n'est pas
// rapprochable → blocage (jamais d'avoir générique qui mésimpute l'acompte).

/** Entrée minimale pour détecter / résoudre la contre-passation d'un 503. */
export interface AdvanceCreditNoteResolveInput {
  direction: string;
  totalInclTax: Prisma.Decimal | number;
  correctedInvoiceRef: string | null;
  supplierPaIdentifier: string;
}

/** Contre-passation résolue, prête pour le payload `DownPaymentsToDraw` de l'avoir. */
export type AdvanceReversal =
  | { ok: true; advanceDocEntry: number; advanceInvoiceId: string; amount: number }
  | { ok: false; reason: string };

/** Détecte un 503 : avoir d'acompte (`ADVANCE_CREDIT_NOTE`). */
export function isAdvanceCreditNote(invoice: { direction: string }): boolean {
  return invoice.direction === 'ADVANCE_CREDIT_NOTE';
}

/**
 * Résout l'acompte 386 à contre-passer pour un avoir d'acompte 503.
 *
 * Retourne `{ ok: true, advanceDocEntry, advanceInvoiceId, amount }` si l'acompte
 * est rapprochable, sinon `{ ok: false, reason }` (jamais d'avoir générique).
 * Le montant contre-passé est celui du 503 ; un montant > acompte d'origine est
 * refusé (incohérence). Le partiel (montant < acompte) est explicitement autorisé.
 */
export async function resolveAdvanceForCreditNote(
  invoice: AdvanceCreditNoteResolveInput,
): Promise<AdvanceReversal> {
  // Les avoirs peuvent être stockés en magnitude (positive) ou en négatif selon
  // le parseur : on raisonne sur la valeur absolue du montant à contre-passer.
  const amount = Math.abs(Number(invoice.totalInclTax));
  if (!(amount > 0)) {
    return { ok: false, reason: "Montant du 503 (avoir d'acompte) nul : rien à contre-passer." };
  }

  const found = await findPostedAdvance(invoice.supplierPaIdentifier, invoice.correctedInvoiceRef);
  if (!found.ok) return found;
  const { advance } = found;

  // On ne contre-passe jamais plus que le montant de l'acompte d'origine.
  if (advance.totalInclTax > 0 && amount > advance.totalInclTax + 0.01) {
    return {
      ok: false,
      reason: `Montant de contre-passation incohérent : ${amount.toFixed(2)} € (503) > montant de l'acompte 386 (${advance.totalInclTax.toFixed(2)} €).`,
    };
  }

  return {
    ok: true,
    advanceDocEntry: advance.sapDocEntry,
    advanceInvoiceId: advance.id,
    amount,
  };
}
