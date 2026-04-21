import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPaStatusPayload,
  computeNextRetryAt,
  getPaStatusRetryPolicy,
  isPaStatusRetryDue,
} from '@pa-sap-bridge/database';

describe('pa-status policy', () => {
  const oldMaxRetries = process.env.PA_STATUS_MAX_RETRIES;
  const oldRetryDelays = process.env.PA_STATUS_RETRY_DELAYS_MS;

  afterEach(() => {
    process.env.PA_STATUS_MAX_RETRIES = oldMaxRetries;
    process.env.PA_STATUS_RETRY_DELAYS_MS = oldRetryDelays;
    vi.useRealTimers();
  });

  it('uses defaults when env is absent', () => {
    delete process.env.PA_STATUS_MAX_RETRIES;
    delete process.env.PA_STATUS_RETRY_DELAYS_MS;

    expect(getPaStatusRetryPolicy()).toEqual({
      maxRetries: 3,
      retryDelaysMs: [0, 60_000, 300_000],
    });
  });

  it('computes next retry from env policy', () => {
    process.env.PA_STATUS_MAX_RETRIES = '4';
    process.env.PA_STATUS_RETRY_DELAYS_MS = '0,1000,5000,10000';

    const base = new Date('2026-04-21T10:00:00.000Z');
    expect(computeNextRetryAt(0, base)?.toISOString()).toBe('2026-04-21T10:00:00.000Z');
    expect(computeNextRetryAt(1, base)?.toISOString()).toBe('2026-04-21T10:00:01.000Z');
    expect(computeNextRetryAt(2, base)?.toISOString()).toBe('2026-04-21T10:00:05.000Z');
    expect(computeNextRetryAt(4, base)).toBeNull();
  });

  it('tells whether retry is due', () => {
    process.env.PA_STATUS_RETRY_DELAYS_MS = '0,1000,5000';
    const lastFailure = new Date('2026-04-21T10:00:00.000Z');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T10:00:00.500Z'));
    expect(isPaStatusRetryDue(1, lastFailure)).toBe(false);

    vi.setSystemTime(new Date('2026-04-21T10:00:01.000Z'));
    expect(isPaStatusRetryDue(1, lastFailure)).toBe(true);
  });

  it('builds a VALIDATED payload for POSTED invoices', () => {
    const payload = buildPaStatusPayload({
      paMessageId: 'MSG-1',
      docNumberPa: 'DOC-1',
      paSource: 'TEST',
      status: 'POSTED',
      statusReason: null,
      sapDocEntry: 123,
      sapDocNum: 456,
    });

    expect(payload.outcome).toBe('VALIDATED');
    expect(payload.reason).toBeNull();
    expect(payload.sapDocNum).toBe(456);
  });
});
