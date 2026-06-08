-- Source de vérité non plafonnée pour la ré-version au détachement : la liste complète
-- des IDs de factures repointées vers le maître est désormais persistée sur la ligne
-- SupplierMerge (et non plus reconstituée depuis l'audit, plafonné à 20 éléments).
-- Additive, `migrate deploy`-safe. Les mappings existants gardent '[]' (ré-version vide).

ALTER TABLE "supplier_merges"
  ADD COLUMN "repointed_invoice_ids" JSONB NOT NULL DEFAULT '[]';
