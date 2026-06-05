-- Remplace la contrainte d'unicité PLEINE (doc_number_pa, supplier_pa_identifier) par un
-- INDEX UNIQUE PARTIEL excluant les factures SUPERSEDED.
--
-- Motivation : une rectificative 384 liée à un litige doit pouvoir coexister avec son originale,
-- même si elle réutilise le même numéro de document. L'originale étant passée SUPERSEDED, elle
-- sort du périmètre d'unicité ; seules les factures « actives » (tout statut ≠ SUPERSEDED) restent
-- soumises au dédoublonnage. Le comportement de dédoublonnage des factures non-384 est donc inchangé.
--
-- NB : référence la valeur d'enum 'SUPERSEDED' → migration distincte de son ADD VALUE
-- (Postgres interdit d'utiliser une valeur d'enum ajoutée dans la même transaction).
--
-- Le nom DB courant de la contrainte est "invoices_doc_number_pa_supplier_pa_identifier_key"
-- (renommée dans la migration 20260429144108). On nettoie les deux noms historiques par sécurité.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_doc_number_pa_supplier_pa_identifier_key";
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "uq_invoices_doc_supplier";

-- Index plein (non unique) pour les lookups de dédoublonnage (findFirst doc+fournisseur, tous statuts)
CREATE INDEX IF NOT EXISTS "idx_invoices_doc_supplier"
  ON "invoices" ("doc_number_pa", "supplier_pa_identifier");

-- Index unique PARTIEL : unicité métier sur les factures actives uniquement
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoices_doc_supplier_active"
  ON "invoices" ("doc_number_pa", "supplier_pa_identifier")
  WHERE "status" <> 'SUPERSEDED';
