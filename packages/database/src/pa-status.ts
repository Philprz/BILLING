export type PaStatusOutcome = 'VALIDATED' | 'REJECTED';

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
    retryDelaysMs: parseRetryDelays(process.env.PA_STATUS_RETRY_DELAYS_MS) ?? DEFAULT_RETRY_DELAYS_MS,
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

export function isPaStatusRetryDue(failureCount: number, lastFailureAt: Date | null, now = new Date()): boolean {
  if (failureCount <= 0 || !lastFailureAt) return true;
  const nextRetryAt = computeNextRetryAt(failureCount, lastFailureAt);
  return nextRetryAt !== null && nextRetryAt.getTime() <= now.getTime();
}

export function buildPaStatusPayload(invoice: {
  paMessageId: string;
  docNumberPa: string;
  paSource: string;
  status: string;
  statusReason: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
}): PaStatusPayload {
  const outcome: PaStatusOutcome = invoice.status === 'POSTED' ? 'VALIDATED' : 'REJECTED';

  return {
    paMessageId: invoice.paMessageId,
    docNumberPa: invoice.docNumberPa,
    paSource: invoice.paSource,
    outcome,
    reason: invoice.statusReason ?? null,
    sapDocEntry: invoice.sapDocEntry,
    sapDocNum: invoice.sapDocNum,
    sentAt: new Date().toISOString(),
  };
}
