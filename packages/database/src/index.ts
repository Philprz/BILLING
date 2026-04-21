export { prisma } from './client';
export {
  createAuditLog,
  createAuditLogBestEffort,
  buildAuditSummary,
} from './audit';
export {
  buildPaStatusPayload,
  computeNextRetryAt,
  getPaStatusRetryPolicy,
  isPaStatusRetryDue,
} from './pa-status';
export type {
  PaStatusOutcome,
  PaStatusPayload,
  PaStatusRetryPolicy,
} from './pa-status';

// Re-export des types Prisma pour éviter aux consommateurs
// d'importer directement depuis @prisma/client
export type {
  Invoice,
  InvoiceLine,
  InvoiceFile,
  SupplierCache,
  MappingRule,
  AuditLog,
  PaChannel,
  Setting,
  InvoiceDirection,
  InvoiceFormat,
  InvoiceStatus,
  IntegrationMode,
  FileKind,
  MappingScope,
  AuditAction,
  AuditEntityType,
  AuditOutcome,
  PaProtocol,
  PaAuthType,
  Prisma,
} from '@prisma/client';

export { PrismaClient } from '@prisma/client';
