export { prisma } from './client';
export { createAuditLog, createAuditLogBestEffort, buildAuditSummary } from './audit';
export {
  buildPaStatusPayload,
  computeNextRetryAt,
  getPaStatusRetryPolicy,
  isPaStatusRetryDue,
} from './pa-status';
export type { PaStatusOutcome, PaStatusPayload, PaStatusRetryPolicy } from './pa-status';
export {
  NOVA_STATUT_SCALE,
  novaStatutRank,
  isNovaStatut,
  mapSapSettlementToNovaStatut,
  mapPaLifecycleToNovaStatut,
  consolidateNovaStatut,
} from './nova-statut';
export type {
  NovaStatut,
  NovaStatutSource,
  NovaStatutCandidate,
  NovaStatutConsolidated,
} from './nova-statut';

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
  AppUser,
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
  Role,
  Prisma,
} from '@prisma/client';

export { PrismaClient } from '@prisma/client';
