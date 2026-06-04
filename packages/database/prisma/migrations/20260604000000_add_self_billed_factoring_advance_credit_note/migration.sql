-- Ajoute les directions SELF_BILLED (389 autofacturation), FACTORING (393 affacturage)
-- et ADVANCE_CREDIT_NOTE (503 avoir d'acompte).
-- ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction PostgreSQL ;
-- chaque valeur est ajoutée idempotemment (compatible `migrate deploy`).
ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS 'SELF_BILLED';
ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS 'FACTORING';
ALTER TYPE "InvoiceDirection" ADD VALUE IF NOT EXISTS 'ADVANCE_CREDIT_NOTE';
