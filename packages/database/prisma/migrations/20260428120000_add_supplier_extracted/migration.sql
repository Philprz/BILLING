-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CREATE_SUPPLIER';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN "supplier_extracted" JSONB;
