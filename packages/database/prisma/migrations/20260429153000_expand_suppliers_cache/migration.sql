-- Extension non destructive du cache fournisseurs SAP B1.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SYNC_SUPPLIERS';

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "supplier_match_reason" TEXT;

ALTER TABLE "suppliers_cache"
  ADD COLUMN IF NOT EXISTS "cardtype" TEXT,
  ADD COLUMN IF NOT EXISTS "tax_id0" TEXT,
  ADD COLUMN IF NOT EXISTS "tax_id1" TEXT,
  ADD COLUMN IF NOT EXISTS "tax_id2" TEXT,
  ADD COLUMN IF NOT EXISTS "phone1" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "zip_code" TEXT,
  ADD COLUMN IF NOT EXISTS "country" TEXT,
  ADD COLUMN IF NOT EXISTS "valid_for" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "raw_payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "last_sync_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE "suppliers_cache"
SET
  "last_sync_at" = COALESCE("last_sync_at", "sync_at", now()),
  "updated_at" = COALESCE("updated_at", "sync_at", now()),
  "created_at" = COALESCE("created_at", "sync_at", now()),
  "raw_payload" = COALESCE("raw_payload", '{}'::jsonb);

CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_cardcode" ON "suppliers_cache"("cardcode");
CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_federaltaxid" ON "suppliers_cache"("federaltaxid");
CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_vatregnum" ON "suppliers_cache"("vatregnum");
CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_tax_id0" ON "suppliers_cache"("tax_id0");
CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_valid_for" ON "suppliers_cache"("valid_for");

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "idx_suppliers_cache_cardname_trgm"
  ON "suppliers_cache" USING gin ("cardname" gin_trgm_ops);
