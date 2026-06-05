-- Ajoute le statut terminal SUPERSEDED (originale remplacée par une rectificative 384)
-- ALTER TYPE … ADD VALUE ne peut pas s'exécuter dans une transaction PostgreSQL < 12 ;
-- ajouté idempotemment (compatible `migrate deploy`). La VALEUR n'est PAS utilisée dans
-- cette migration (l'index partiel qui la référence est dans une migration séparée :
-- Postgres interdit d'utiliser une valeur d'enum ajoutée dans la même transaction).
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

-- Colonne nullable additive : self-relation de supersession (portée par le 384, pointe vers l'originale)
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "replaces_invoice_id" UUID;

-- Contrainte FK self (ON DELETE SET NULL : la suppression d'une originale ne supprime pas le 384)
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_replaces_invoice_id_fkey"
  FOREIGN KEY ("replaces_invoice_id") REFERENCES "invoices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index sur la colonne FK (pratique Prisma pour les relations)
CREATE INDEX IF NOT EXISTS "invoices_replaces_invoice_id_idx" ON "invoices"("replaces_invoice_id");
