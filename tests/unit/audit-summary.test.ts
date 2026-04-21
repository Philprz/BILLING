import { describe, expect, it } from 'vitest';
import { buildAuditSummary } from '@pa-sap-bridge/database';

describe('buildAuditSummary', () => {
  it('formats retry errors for PA status', () => {
    const summary = buildAuditSummary({
      action: 'SEND_STATUS_PA',
      outcome: 'ERROR',
      errorMessage: 'timeout',
      payloadAfter: {
        attempt: 2,
        maxRetries: 3,
        nextRetryAt: '2026-04-21T10:05:00.000Z',
      },
    });

    expect(summary).toContain('tentative 2/3');
    expect(summary).toContain('2026-04-21T10:05:00.000Z');
  });

  it('formats approve success', () => {
    const summary = buildAuditSummary({
      action: 'APPROVE',
      outcome: 'OK',
      payloadAfter: {
        status: 'POSTED',
        integrationMode: 'SERVICE_INVOICE',
        sapDocNum: 46000,
      },
    });

    expect(summary).toContain('Validation POSTED');
    expect(summary).toContain('SERVICE_INVOICE');
    expect(summary).toContain('46000');
  });
});
