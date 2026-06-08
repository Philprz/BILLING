-- Valeurs d'enum additives pour tracer les rattachements/détachements de doublons.
-- ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction PostgreSQL < 12.
-- Idempotent (IF NOT EXISTS), `migrate deploy`-safe, aucune donnée impactée.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MERGE_SUPPLIER';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNMERGE_SUPPLIER';
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'SUPPLIER';
