-- Ajoute le statut DISPUTED (litige) à InvoiceStatus
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

-- Ajoute les actions d'audit pour la mise/levée de litige
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVOICE_LITIGE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVOICE_LITIGE_LEVE';

-- Champs nullable additifs sur invoices (non destructif)
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "litige_motif" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "litige_date" TIMESTAMPTZ(6);
