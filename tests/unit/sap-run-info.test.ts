import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../apps/web/src/api/types';
import {
  extractLatestSapRunInfo,
  formatPolicyLabel,
  formatStageLabel,
} from '../../apps/web/src/lib/sap-run-info';

function makeAuditEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'audit-1',
    occurredAt: '2026-04-22T12:00:00.000Z',
    sapUser: 'tester',
    action: 'POST_SAP',
    entityType: 'INVOICE',
    entityId: 'invoice-1',
    outcome: 'OK',
    errorMessage: null,
    payloadBefore: null,
    payloadAfter: null,
    summary: 'summary',
    ...overrides,
  };
}

describe('sap-run-info helpers', () => {
  it('extracts latest sap policy and validation report from audit payloads', () => {
    const info = extractLatestSapRunInfo([
      makeAuditEntry({
        payloadAfter: {
          stage: 'SAP_VALIDATION_OK',
          integrationMode: 'SERVICE_INVOICE',
          simulate: false,
          policy: {
            validationMode: 'live',
            attachmentPolicy: 'warn',
            postPolicy: 'real',
            requestSimulate: false,
            effectivePostPolicy: 'real',
          },
          validationReport: {
            ok: true,
            integrationMode: 'SERVICE_INVOICE',
            validatedAt: '2026-04-22T11:59:00.000Z',
            checkedRefs: {
              supplierCardCode: 'F_TEST',
              accountCodes: ['601000'],
              taxCodes: ['S1'],
              costCenters: [],
            },
            issues: [],
          },
        },
      }),
    ]);

    expect(info?.policy?.attachmentPolicy).toBe('warn');
    expect(info?.validationReport?.checkedRefs.accountCodes).toEqual(['601000']);
    expect(info?.stage).toBe('SAP_VALIDATION_OK');
  });

  it('ignores audit entries without sap execution payloads', () => {
    const info = extractLatestSapRunInfo([
      makeAuditEntry({ action: 'VIEW_INVOICE', payloadAfter: { status: 'READY' } }),
    ]);

    expect(info).toBeNull();
  });

  it('formats stage and policy labels', () => {
    expect(formatStageLabel('SAP_POST_SIMULATED', 'OK')).toContain('simulé');
    expect(formatPolicyLabel('disabled')).toBe('disabled');
  });
});
