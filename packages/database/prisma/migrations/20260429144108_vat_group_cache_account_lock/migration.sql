-- DropIndex
DROP INDEX "idx_suppliers_cache_cardname_trgm";

-- AlterTable
ALTER TABLE "chart_of_accounts_cache" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "account_code_locked_by_user" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "suppliers_cache" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "vat_group_cache" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB,
    "sync_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_group_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vat_group_cache_code_key" ON "vat_group_cache"("code");

-- CreateIndex
CREATE INDEX "idx_vat_group_cache_rate" ON "vat_group_cache"("rate");

-- RenameIndex
ALTER INDEX "uq_invoices_doc_supplier" RENAME TO "invoices_doc_number_pa_supplier_pa_identifier_key";
