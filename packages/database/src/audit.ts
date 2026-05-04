import { prisma } from './client';
import type { AuditAction, AuditEntityType, AuditOutcome, Prisma } from '@prisma/client';

const MAX_STRING_LENGTH = 300;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 20;
const MAX_DEPTH = 5;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|session|credential|api[-_]?key/i;

export interface CreateAuditLogInput {
  sapUser?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  payloadBefore?: unknown;
  payloadAfter?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  outcome?: AuditOutcome;
  errorMessage?: string | null;
}

export interface AuditSummaryInput {
  action: AuditAction;
  outcome: AuditOutcome;
  payloadBefore?: unknown;
  payloadAfter?: unknown;
  errorMessage?: string | null;
}

function truncateString(value: string, max = MAX_STRING_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 12)}… [truncated]`;
}

function sanitizeValue(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (depth >= MAX_DEPTH) return '[max-depth]';

  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items as Prisma.InputJsonValue;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries.slice(0, MAX_OBJECT_KEYS);

    const sanitizedObject: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, raw] of limitedEntries) {
      sanitizedObject[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(raw, depth + 1);
    }

    if (entries.length > MAX_OBJECT_KEYS) {
      sanitizedObject.__truncatedKeys = `[+${entries.length - MAX_OBJECT_KEYS} more keys]`;
    }

    return sanitizedObject as Prisma.InputJsonValue;
  }

  return truncateString(String(value));
}

function sanitizeText(value?: string | null): string | null {
  if (!value) return null;
  return truncateString(value);
}

function toNullableJsonInput(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  const sanitized = sanitizeValue(value);
  return sanitized === null ? undefined : sanitized;
}

export async function createAuditLog(input: CreateAuditLogInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      sapUser: sanitizeText(input.sapUser),
      action: input.action,
      entityType: input.entityType,
      entityId: sanitizeText(input.entityId),
      payloadBefore: toNullableJsonInput(input.payloadBefore),
      payloadAfter: toNullableJsonInput(input.payloadAfter),
      ipAddress: sanitizeText(input.ipAddress),
      userAgent: sanitizeText(input.userAgent),
      outcome: input.outcome ?? 'OK',
      errorMessage: sanitizeText(input.errorMessage),
    },
  });
}

export async function createAuditLogBestEffort(input: CreateAuditLogInput): Promise<void> {
  try {
    await createAuditLog(input);
  } catch {
    // L'audit ne doit pas masquer l'opération principale.
  }
}

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export function buildAuditSummary(input: AuditSummaryInput): string {
  const { action, outcome, payloadAfter, payloadBefore, errorMessage } = input;
  const stage = readString(payloadAfter, 'stage');

  if (outcome === 'ERROR') {
    const attempt = readNumber(payloadAfter, 'attempt');
    if (action === 'SEND_STATUS_PA' && attempt) {
      const maxRetries = readNumber(payloadAfter, 'maxRetries');
      const nextRetryAt = readString(payloadAfter, 'nextRetryAt');
      const retryPart = maxRetries ? `tentative ${attempt}/${maxRetries}` : `tentative ${attempt}`;
      const nextPart = nextRetryAt ? `, prochain essai ${nextRetryAt}` : '';
      return `Envoi statut PA en erreur (${retryPart}${nextPart})`;
    }
    if (stage === 'SAP_VALIDATION_ERROR') {
      return errorMessage ?? 'Validation SAP en erreur';
    }
    if (stage === 'ATTACHMENT_UPLOAD_ERROR') {
      return errorMessage ?? 'Upload pièce jointe SAP en erreur';
    }
    if (stage === 'SAP_POST_DISABLED_BY_POLICY') {
      return 'Intégration SAP désactivée par politique';
    }
    return errorMessage ?? `${action} en erreur`;
  }

  switch (action) {
    case 'VIEW_INVOICE': {
      const status = readString(payloadAfter, 'status');
      const docNumberPa = readString(payloadAfter, 'docNumberPa');
      return docNumberPa && status
        ? `Consultation ${docNumberPa} (${status})`
        : 'Consultation facture';
    }
    case 'APPROVE': {
      const afterStatus = readString(payloadAfter, 'status');
      const integrationMode = readString(payloadAfter, 'integrationMode');
      const sapDocNum = readNumber(payloadAfter, 'sapDocNum');
      const docPart = sapDocNum ? `, DocNum ${sapDocNum}` : '';
      const simulated = (payloadAfter as Record<string, unknown> | null)?.simulate === true;
      return `Validation ${afterStatus ?? 'OK'}${simulated ? ' simulée' : ''}${integrationMode ? ` via ${integrationMode}` : ''}${docPart}`;
    }
    case 'REJECT': {
      const reason = readString(payloadAfter, 'reason');
      return reason ? `Rejet: ${reason}` : 'Rejet manuel';
    }
    case 'LINK_SAP': {
      const sapDocNum = readNumber(payloadAfter, 'sapDocNum');
      const numAtCard = readString(payloadAfter, 'numAtCard');
      const attachmentEntry = readNumber(payloadAfter, 'attachmentEntry');
      const parts = [
        'Rattachement SAP',
        numAtCard ? `NumAtCard ${numAtCard}` : null,
        sapDocNum ? `DocNum ${sapDocNum}` : null,
        attachmentEntry ? `PJ AbsEntry ${attachmentEntry}` : null,
      ].filter(Boolean);
      return parts.join(' · ');
    }
    case 'POST_SAP': {
      if (stage === 'SAP_VALIDATION_OK') {
        return 'Validation SAP OK';
      }
      if (stage === 'ATTACHMENT_UPLOAD_OK') {
        return 'Pièce jointe SAP uploadée';
      }
      if (stage === 'ATTACHMENT_UPLOAD_WARNING') {
        return 'Upload pièce jointe SAP en warning';
      }
      if (stage === 'ATTACHMENT_POLICY_BYPASS') {
        return 'Pièce jointe SAP ignorée par politique';
      }
      if (stage === 'ATTACHMENT_SKIPPED_SIMULATE') {
        return 'Pièce jointe SAP ignorée (mode simulé)';
      }
      const integrationMode = readString(payloadAfter, 'integrationMode');
      const sapDocNum = readNumber(payloadAfter, 'sapDocNum');
      const simulated = (payloadAfter as Record<string, unknown> | null)?.simulate === true;
      const label =
        stage === 'SAP_POST_SIMULATED' || simulated ? 'Intégration SAP simulée' : 'Intégration SAP';
      return `${label}${integrationMode ? ` (${integrationMode})` : ''}${sapDocNum ? `, DocNum ${sapDocNum}` : ''}`;
    }
    case 'SEND_STATUS_PA': {
      const deliveryMode = readString(payloadAfter, 'deliveryMode');
      const paOutcome = readString(payloadAfter, 'outcome');
      const attempt = readNumber(payloadAfter, 'attempt');
      const targetFile = readString(payloadAfter, 'targetFile');
      const parts = [
        paOutcome ? `Statut PA ${paOutcome}` : 'Statut PA envoyé',
        deliveryMode ? `mode ${deliveryMode}` : null,
        attempt ? `tentative ${attempt}` : null,
        targetFile ? targetFile : null,
      ].filter(Boolean);
      return parts.join(' · ');
    }
    case 'FETCH_PA': {
      const created =
        typeof (payloadAfter as Record<string, unknown> | null)?.created === 'boolean'
          ? (payloadAfter as Record<string, unknown>).created
          : null;
      const filename = readString(payloadAfter, 'filename');
      if (filename) {
        return `${created === false ? 'Doublon ignoré' : 'Ingestion'} ${filename}`;
      }
      return 'Ingestion PA';
    }
    default: {
      const beforeStatus = readString(payloadBefore, 'status');
      const afterStatus = readString(payloadAfter, 'status');
      if (beforeStatus || afterStatus) {
        return `${action}: ${beforeStatus ?? '—'} -> ${afterStatus ?? '—'}`;
      }
      return action;
    }
  }
}
