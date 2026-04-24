import type {
  AuditEntry,
  SapExecutionPolicy,
  SapValidationIssue,
  SapValidationReport,
} from '../api/types';

export interface SapRunInfo {
  occurredAt: string;
  outcome: 'OK' | 'ERROR';
  summary: string;
  stage: string | null;
  policy: SapExecutionPolicy | null;
  validationReport: SapValidationReport | null;
  integrationMode: string | null;
  attachmentWarning: string | null;
  simulate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePolicy(value: unknown): SapExecutionPolicy | null {
  if (!isRecord(value)) return null;
  const validationMode = value.validationMode;
  const attachmentPolicy = value.attachmentPolicy;
  const postPolicy = value.postPolicy;
  const requestSimulate = value.requestSimulate;
  const effectivePostPolicy = value.effectivePostPolicy;

  if (
    validationMode !== 'live' ||
    (attachmentPolicy !== 'strict' && attachmentPolicy !== 'warn' && attachmentPolicy !== 'skip') ||
    (postPolicy !== 'real' && postPolicy !== 'simulate' && postPolicy !== 'disabled') ||
    typeof requestSimulate !== 'boolean' ||
    (effectivePostPolicy !== 'real' &&
      effectivePostPolicy !== 'simulate' &&
      effectivePostPolicy !== 'disabled')
  ) {
    return null;
  }

  return {
    validationMode,
    attachmentPolicy,
    postPolicy,
    requestSimulate,
    effectivePostPolicy,
  };
}

function parseIssues(value: unknown): SapValidationIssue[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((issue) => ({
    severity: issue.severity === 'ERROR' ? 'ERROR' : 'ERROR',
    code: typeof issue.code === 'string' ? issue.code : 'UNKNOWN',
    message: typeof issue.message === 'string' ? issue.message : 'Erreur SAP',
    lineNo: typeof issue.lineNo === 'number' ? issue.lineNo : undefined,
    field: typeof issue.field === 'string' ? issue.field : undefined,
    value: typeof issue.value === 'string' || issue.value === null ? issue.value : undefined,
  }));
}

function parseValidationReport(value: unknown): SapValidationReport | null {
  if (!isRecord(value) || !isRecord(value.checkedRefs)) return null;

  const ok = value.ok;
  const integrationMode = value.integrationMode;
  const validatedAt = value.validatedAt;
  const checkedRefs = value.checkedRefs;

  if (
    typeof ok !== 'boolean' ||
    (integrationMode !== 'SERVICE_INVOICE' && integrationMode !== 'JOURNAL_ENTRY') ||
    typeof validatedAt !== 'string' ||
    !Array.isArray(checkedRefs.accountCodes) ||
    !Array.isArray(checkedRefs.taxCodes) ||
    !Array.isArray(checkedRefs.costCenters)
  ) {
    return null;
  }

  return {
    ok,
    integrationMode,
    validatedAt,
    checkedRefs: {
      supplierCardCode:
        typeof checkedRefs.supplierCardCode === 'string' || checkedRefs.supplierCardCode === null
          ? checkedRefs.supplierCardCode
          : null,
      accountCodes: checkedRefs.accountCodes.filter(
        (value): value is string => typeof value === 'string',
      ),
      taxCodes: checkedRefs.taxCodes.filter((value): value is string => typeof value === 'string'),
      costCenters: checkedRefs.costCenters.filter(
        (value): value is string => typeof value === 'string',
      ),
    },
    issues: parseIssues(value.issues),
  };
}

export function extractLatestSapRunInfo(entries: AuditEntry[]): SapRunInfo | null {
  for (const entry of entries) {
    if (entry.action !== 'POST_SAP' && entry.action !== 'APPROVE') continue;
    if (!isRecord(entry.payloadAfter)) continue;

    const policy = parsePolicy(entry.payloadAfter.policy);
    const validationReport = parseValidationReport(entry.payloadAfter.validationReport);
    if (!policy && !validationReport) continue;

    return {
      occurredAt: entry.occurredAt,
      outcome: entry.outcome,
      summary: entry.summary,
      stage: typeof entry.payloadAfter.stage === 'string' ? entry.payloadAfter.stage : null,
      policy,
      validationReport,
      integrationMode:
        typeof entry.payloadAfter.integrationMode === 'string'
          ? entry.payloadAfter.integrationMode
          : null,
      attachmentWarning:
        typeof entry.payloadAfter.attachmentWarning === 'string'
          ? entry.payloadAfter.attachmentWarning
          : null,
      simulate: entry.payloadAfter.simulate === true,
    };
  }

  return null;
}

export function formatPolicyLabel(
  value: 'strict' | 'warn' | 'skip' | 'real' | 'simulate' | 'disabled',
): string {
  switch (value) {
    case 'strict':
      return 'strict';
    case 'warn':
      return 'warn';
    case 'skip':
      return 'skip';
    case 'real':
      return 'real';
    case 'simulate':
      return 'simulate';
    case 'disabled':
      return 'disabled';
  }
}

export function formatStageLabel(stage: string | null, outcome: 'OK' | 'ERROR'): string {
  switch (stage) {
    case 'SAP_VALIDATION_OK':
      return 'Validation SAP OK';
    case 'SAP_VALIDATION_ERROR':
      return 'Validation SAP en erreur';
    case 'ATTACHMENT_UPLOAD_OK':
      return 'Pièce jointe SAP uploadée';
    case 'ATTACHMENT_UPLOAD_WARNING':
      return 'Pièce jointe SAP en warning';
    case 'ATTACHMENT_UPLOAD_ERROR':
      return 'Pièce jointe SAP en erreur';
    case 'ATTACHMENT_POLICY_BYPASS':
      return 'Pièce jointe SAP ignorée par politique';
    case 'ATTACHMENT_SKIPPED_SIMULATE':
      return 'Pièce jointe ignorée en mode simulé';
    case 'SAP_POST_OK':
      return 'Post SAP réel réussi';
    case 'SAP_POST_SIMULATED':
      return 'Post SAP simulé';
    case 'SAP_POST_ERROR':
      return 'Post SAP en erreur';
    case 'SAP_POST_DISABLED_BY_POLICY':
      return 'Post SAP désactivé par politique';
    default:
      return outcome === 'OK' ? 'Exécution SAP OK' : 'Exécution SAP en erreur';
  }
}
