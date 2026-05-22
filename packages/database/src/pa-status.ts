export type PaStatusOutcome = 'VALIDATED' | 'REJECTED' | 'IN_DISPUTE' | 'RECEIVED';

export interface PaStatusPayload {
  paMessageId: string;
  docNumberPa: string;
  paSource: string;
  outcome: PaStatusOutcome;
  reason: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sentAt: string;
}

export interface PaStatusRetryPolicy {
  maxRetries: number;
  retryDelaysMs: number[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAYS_MS = [0, 60_000, 300_000];

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRetryDelays(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? values : null;
}

export function getPaStatusRetryPolicy(): PaStatusRetryPolicy {
  return {
    maxRetries: parsePositiveInteger(process.env.PA_STATUS_MAX_RETRIES) ?? DEFAULT_MAX_RETRIES,
    retryDelaysMs:
      parseRetryDelays(process.env.PA_STATUS_RETRY_DELAYS_MS) ?? DEFAULT_RETRY_DELAYS_MS,
  };
}

function getDelayForFailureCount(failureCount: number, retryDelaysMs: number[]): number {
  if (failureCount <= 0) return retryDelaysMs[0] ?? 0;
  const index = Math.min(failureCount, retryDelaysMs.length - 1);
  return retryDelaysMs[index] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0;
}

export function computeNextRetryAt(failureCount: number, from: Date): Date | null {
  const policy = getPaStatusRetryPolicy();
  if (failureCount >= policy.maxRetries) return null;

  const delayMs = getDelayForFailureCount(failureCount, policy.retryDelaysMs);
  return new Date(from.getTime() + delayMs);
}

export function isPaStatusRetryDue(
  failureCount: number,
  lastFailureAt: Date | null,
  now = new Date(),
): boolean {
  if (failureCount <= 0 || !lastFailureAt) return true;
  const nextRetryAt = computeNextRetryAt(failureCount, lastFailureAt);
  return nextRetryAt !== null && nextRetryAt.getTime() <= now.getTime();
}

export function buildPaStatusPayload(
  invoice: {
    paMessageId: string;
    docNumberPa: string;
    paSource: string;
    status: string;
    statusReason: string | null;
    sapDocEntry: number | null;
    sapDocNum: number | null;
    litigeMotif?: string | null;
  },
  outcomeOverride?: PaStatusOutcome,
): PaStatusPayload {
  // POSTED et LINKED (Voie B) → VALIDATED ; DISPUTED → IN_DISPUTE ; tout autre statut terminal → REJECTED
  // outcomeOverride permet de forcer un outcome non dérivable du statut (ex. RECEIVED lors d'une levée de litige
  // où la facture repasse en TO_REVIEW mais on doit signaler le retour dans le cycle PA).
  const derivedOutcome: PaStatusOutcome =
    invoice.status === 'POSTED' || invoice.status === 'LINKED'
      ? 'VALIDATED'
      : invoice.status === 'DISPUTED'
        ? 'IN_DISPUTE'
        : 'REJECTED';
  const outcome = outcomeOverride ?? derivedOutcome;

  // Pour IN_DISPUTE, le motif vit dans litige_motif, pas dans status_reason
  const reason =
    outcome === 'IN_DISPUTE' ? (invoice.litigeMotif ?? null) : (invoice.statusReason ?? null);

  return {
    paMessageId: invoice.paMessageId,
    docNumberPa: invoice.docNumberPa,
    paSource: invoice.paSource,
    outcome,
    reason,
    sapDocEntry: invoice.sapDocEntry,
    sapDocNum: invoice.sapDocNum,
    sentAt: new Date().toISOString(),
  };
}
