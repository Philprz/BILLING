-- Ajoute la direction ADVANCE_INVOICE (factures d'acompte — TypeCode 386)
ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS 'ADVANCE_INVOICE';

-- Champ nullable additif sur invoices (BT-113 PrepaidAmount — montant acompte déjà versé)
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "prepaid_amount" DECIMAL(19,4);
