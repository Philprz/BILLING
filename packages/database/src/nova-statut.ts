/**
 * Niveau payé (matrice S/B 2) — échelle ordonnée U_NOVA_Statut et logique de
 * consolidation « l'état le plus avancé gagne ».
 *
 * Échelle (strictement ordonnée) :
 *   NON_PAYE < PROGRAMME < PARTIEL < PAYE < SOLDE
 *
 * Deux sources alimentent l'échelle (décision verrouillée du lot) :
 *   - SAP  : état de règlement du poste (paiement / lettrage) — DocumentStatus + PaidToDate.
 *   - PA   : statut du cycle de vie réforme déjà ingéré (paPaymentStatus).
 * La consolidation retient l'**état le plus avancé**, en conservant **source + horodatage**
 * (traçabilité). Le job de suivi ne réécrit l'UDF SAP que si la valeur change.
 *
 * Logique pure (aucune I/O) → directement testable, et réutilisable côté worker.
 */

export type NovaStatut = 'NON_PAYE' | 'PROGRAMME' | 'PARTIEL' | 'PAYE' | 'SOLDE';

export type NovaStatutSource = 'SAP' | 'PA';

/** Échelle ordonnée, du moins avancé au plus avancé. L'index = le rang. */
export const NOVA_STATUT_SCALE: readonly NovaStatut[] = [
  'NON_PAYE',
  'PROGRAMME',
  'PARTIEL',
  'PAYE',
  'SOLDE',
] as const;

/** Rang d'un statut dans l'échelle (−1 si valeur inconnue / hors échelle). */
export function novaStatutRank(value: string | null | undefined): number {
  if (!value) return -1;
  return NOVA_STATUT_SCALE.indexOf(value as NovaStatut);
}

/** Vrai si la chaîne est une valeur valide de l'échelle. */
export function isNovaStatut(value: string | null | undefined): value is NovaStatut {
  return novaStatutRank(value) >= 0;
}

export interface NovaStatutCandidate {
  value: NovaStatut;
  source: NovaStatutSource;
  /** Horodatage de l'observation (ISO ou Date). Sert au départage à rang égal. */
  at: Date;
}

/** Résultat consolidé : l'état le plus avancé, avec sa source et son horodatage. */
export interface NovaStatutConsolidated {
  value: NovaStatut;
  source: NovaStatutSource;
  at: Date;
}

/**
 * Mappe l'état de règlement SAP d'un poste fournisseur vers l'échelle.
 *
 * Confirmé LIVE (lecture seule, scripts/inspect-bp-paymentmethod-novastatut.ts) :
 *   - `PurchaseInvoices` n'expose PAS d'`OpenAmount` → le **montant ouvert = DocTotal − PaidToDate**.
 *   - `DocumentStatus` ∈ { bost_Open, bost_Close } (BoStatus).
 *
 * Mapping (la source SAP ne produit jamais PROGRAMME ni PAYE — réservés à la PA) :
 *   - poste clos (bost_Close) OU réglé en totalité (PaidToDate ≥ DocTotal)        → SOLDE
 *   - rien de réglé (PaidToDate ≈ 0)                                              → NON_PAYE
 *   - partiellement réglé (0 < PaidToDate < DocTotal)                             → PARTIEL
 */
export function mapSapSettlementToNovaStatut(settlement: {
  docTotal: number;
  paidToDate: number;
  documentStatus?: string | null;
}): NovaStatut {
  const EPS = 0.01;
  const total = Number(settlement.docTotal) || 0;
  const paid = Number(settlement.paidToDate) || 0;
  const closed = settlement.documentStatus === 'bost_Close';

  if (closed) return 'SOLDE';
  if (total > 0 && paid >= total - EPS) return 'SOLDE';
  if (paid <= EPS) return 'NON_PAYE';
  return 'PARTIEL';
}

/**
 * Mappe un statut de cycle de vie réforme (source PA) vers l'échelle.
 * Tolérant : accepte déjà une valeur d'échelle (passthrough idempotent) ou des
 * libellés métier usuels. Retourne `null` si non interprétable (la PA ne
 * contribue alors pas à la consolidation).
 */
export function mapPaLifecycleToNovaStatut(paStatus: string | null | undefined): NovaStatut | null {
  if (!paStatus) return null;
  const v = paStatus.trim().toUpperCase();
  if (isNovaStatut(v)) return v;

  switch (v) {
    case 'PROGRAMMED':
    case 'SCHEDULED':
    case 'PROGRAMME_PAIEMENT':
    case 'PAYMENT_SCHEDULED':
      return 'PROGRAMME';
    case 'PARTIAL':
    case 'PARTIALLY_PAID':
      return 'PARTIEL';
    case 'PAID':
    case 'ENCAISSE':
    case 'CASHED':
      return 'PAYE';
    case 'SETTLED':
    case 'SOLDE_PA':
    case 'CLEARED':
      return 'SOLDE';
    default:
      return null;
  }
}

/**
 * Consolide plusieurs candidats : retient le **plus avancé** dans l'échelle.
 * À rang égal, départage par horodatage le plus récent (observation la plus fraîche).
 * Retourne `null` si aucun candidat valide.
 */
export function consolidateNovaStatut(
  candidates: ReadonlyArray<NovaStatutCandidate | null | undefined>,
): NovaStatutConsolidated | null {
  let best: NovaStatutConsolidated | null = null;
  for (const c of candidates) {
    if (!c || !isNovaStatut(c.value)) continue;
    if (best === null) {
      best = { value: c.value, source: c.source, at: c.at };
      continue;
    }
    const rankC = novaStatutRank(c.value);
    const rankBest = novaStatutRank(best.value);
    if (rankC > rankBest || (rankC === rankBest && c.at.getTime() > best.at.getTime())) {
      best = { value: c.value, source: c.source, at: c.at };
    }
  }
  return best;
}
