-- Ajoute la direction CORRECTIVE_INVOICE (factures rectificatives — TypeCode 384)
-- ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction PostgreSQL < 12
ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS 'CORRECTIVE_INVOICE';

-- Champ nullable additif sur invoices (BT-3 BillingReference — référence à la facture corrigée)
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "corrected_invoice_ref" TEXT;
