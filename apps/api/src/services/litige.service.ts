/**
 * Logique pure de validation des transitions de statut "litige" (DISPUTED).
 *
 * Voir spec : un litige est suspensif (non terminal). Seules les factures
 * encore en cours de traitement (NEW, TO_REVIEW, READY) peuvent y entrer.
 * Une facture intégrée (POSTED/LINKED) ou rejetée (REJECTED) ne peut pas
 * être mise en litige : il faut utiliser le flux d'avoir ou de rejet.
 */

export const DISPUTABLE_STATUSES = ['NEW', 'TO_REVIEW', 'READY'] as const;
export const LITIGE_MIN_MOTIF_LENGTH = 10;

export type DisputableStatus = (typeof DISPUTABLE_STATUSES)[number];

export type LitigeTransitionError =
  | { kind: 'INVALID_MOTIF'; reason: 'EMPTY' | 'TOO_SHORT' }
  | { kind: 'INVALID_STATUS'; current: string; allowed: readonly string[] };

export function validateLitigeMotif(motif: string): LitigeTransitionError | null {
  const trimmed = motif.trim();
  if (trimmed.length === 0) return { kind: 'INVALID_MOTIF', reason: 'EMPTY' };
  if (trimmed.length < LITIGE_MIN_MOTIF_LENGTH)
    return { kind: 'INVALID_MOTIF', reason: 'TOO_SHORT' };
  return null;
}

export function canPutInLitige(currentStatus: string): boolean {
  return (DISPUTABLE_STATUSES as readonly string[]).includes(currentStatus);
}

export function assertLitigeStatusOk(currentStatus: string): LitigeTransitionError | null {
  if (canPutInLitige(currentStatus)) return null;
  return { kind: 'INVALID_STATUS', current: currentStatus, allowed: DISPUTABLE_STATUSES };
}

export function canLiftLitige(currentStatus: string): boolean {
  return currentStatus === 'DISPUTED';
}

export function assertLiftLitigeStatusOk(currentStatus: string): LitigeTransitionError | null {
  if (canLiftLitige(currentStatus)) return null;
  return { kind: 'INVALID_STATUS', current: currentStatus, allowed: ['DISPUTED'] };
}
