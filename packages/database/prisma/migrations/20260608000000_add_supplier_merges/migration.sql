-- Rattachement des doublons fournisseur (alias → maître SAP).
-- Table additive uniquement, `migrate deploy`-safe : aucune donnée existante impactée,
-- aucune contrainte sur les tables existantes, pas d'ALTER TYPE, pas de backfill.

CREATE TABLE IF NOT EXISTS "supplier_merges" (
  "id" UUID NOT NULL,
  "alias_cardcode" TEXT NOT NULL,
  "master_cardcode" TEXT NOT NULL,
  "reason" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_merges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_merges_alias_cardcode_key" ON "supplier_merges"("alias_cardcode");
CREATE INDEX IF NOT EXISTS "idx_supplier_merges_master" ON "supplier_merges"("master_cardcode");
