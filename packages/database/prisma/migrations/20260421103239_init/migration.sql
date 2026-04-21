-- CreateEnum
CREATE TYPE "InvoiceDirection" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "InvoiceFormat" AS ENUM ('FACTUR_X', 'UBL', 'CII', 'PDF_ONLY', 'CSV', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('NEW', 'TO_REVIEW', 'READY', 'POSTED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "IntegrationMode" AS ENUM ('SERVICE_INVOICE', 'JOURNAL_ENTRY');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('PDF', 'XML', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "MappingScope" AS ENUM ('GLOBAL', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGOUT', 'FETCH_PA', 'VIEW_INVOICE', 'EDIT_MAPPING', 'APPROVE', 'REJECT', 'POST_SAP', 'SEND_STATUS_PA', 'SYSTEM_ERROR', 'CONFIG_CHANGE');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('INVOICE', 'RULE', 'CONFIG', 'SYSTEM', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('OK', 'ERROR');

-- CreateEnum
CREATE TYPE "PaProtocol" AS ENUM ('SFTP', 'API');

-- CreateEnum
CREATE TYPE "PaAuthType" AS ENUM ('BASIC', 'API_KEY', 'OAUTH2');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "pa_message_id" TEXT NOT NULL,
    "pa_source" TEXT NOT NULL,
    "direction" "InvoiceDirection" NOT NULL,
    "format" "InvoiceFormat" NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplier_pa_identifier" TEXT NOT NULL,
    "supplier_name_raw" TEXT NOT NULL,
    "supplier_b1_cardcode" TEXT,
    "supplier_match_confidence" INTEGER NOT NULL DEFAULT 0,
    "doc_number_pa" TEXT NOT NULL,
    "doc_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" CHAR(3) NOT NULL,
    "total_excl_tax" DECIMAL(19,4) NOT NULL,
    "total_tax" DECIMAL(19,4) NOT NULL,
    "total_incl_tax" DECIMAL(19,4) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'NEW',
    "status_reason" TEXT,
    "integration_mode" "IntegrationMode",
    "sap_doc_entry" INTEGER,
    "sap_doc_num" INTEGER,
    "sap_attachment_entry" INTEGER,
    "sap_attachment_uploaded_at" TIMESTAMPTZ(6),
    "pa_status_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unit_price" DECIMAL(19,4) NOT NULL,
    "amount_excl_tax" DECIMAL(19,4) NOT NULL,
    "tax_code" TEXT,
    "tax_rate" DECIMAL(5,2),
    "tax_amount" DECIMAL(19,4) NOT NULL,
    "amount_incl_tax" DECIMAL(19,4) NOT NULL,
    "suggested_account_code" TEXT,
    "suggested_account_confidence" INTEGER NOT NULL DEFAULT 0,
    "suggested_cost_center" TEXT,
    "chosen_account_code" TEXT,
    "chosen_cost_center" TEXT,
    "chosen_tax_code_b1" TEXT,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_files" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "kind" "FileKind" NOT NULL,
    "path" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "invoice_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers_cache" (
    "id" UUID NOT NULL,
    "cardcode" TEXT NOT NULL,
    "cardname" TEXT NOT NULL,
    "federaltaxid" TEXT,
    "vatregnum" TEXT,
    "sync_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_rules" (
    "id" UUID NOT NULL,
    "scope" "MappingScope" NOT NULL,
    "supplier_cardcode" TEXT,
    "match_keyword" TEXT,
    "match_tax_rate" DECIMAL(5,2),
    "match_amount_min" DECIMAL(19,4),
    "match_amount_max" DECIMAL(19,4),
    "account_code" TEXT NOT NULL,
    "cost_center" TEXT,
    "tax_code_b1" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 60,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(6),
    "created_by_user" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mapping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sap_user" TEXT,
    "action" "AuditAction" NOT NULL,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT,
    "payload_before" JSONB,
    "payload_after" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'OK',
    "error_message" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pa_channels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "PaProtocol" NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "user" TEXT,
    "password_encrypted" TEXT,
    "remote_path_in" TEXT,
    "remote_path_processed" TEXT,
    "remote_path_out" TEXT,
    "api_base_url" TEXT,
    "api_auth_type" "PaAuthType",
    "api_credentials_encrypted" TEXT,
    "poll_interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pa_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_pa_message_id_key" ON "invoices"("pa_message_id");

-- CreateIndex
CREATE INDEX "idx_invoices_status" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "idx_invoices_pa_source" ON "invoices"("pa_source");

-- CreateIndex
CREATE INDEX "idx_invoices_doc_date" ON "invoices"("doc_date");

-- CreateIndex
CREATE INDEX "idx_invoices_cardcode" ON "invoices"("supplier_b1_cardcode");

-- CreateIndex
CREATE INDEX "idx_invoices_received_at" ON "invoices"("received_at");

-- CreateIndex
CREATE INDEX "idx_invoice_lines_invoice_id" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "idx_invoice_files_invoice_id" ON "invoice_files"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_cache_cardcode_key" ON "suppliers_cache"("cardcode");

-- CreateIndex
CREATE INDEX "idx_suppliers_cache_cardname" ON "suppliers_cache"("cardname");

-- CreateIndex
CREATE INDEX "idx_suppliers_cache_taxid" ON "suppliers_cache"("federaltaxid");

-- CreateIndex
CREATE INDEX "idx_mapping_rules_scope_active" ON "mapping_rules"("scope", "active");

-- CreateIndex
CREATE INDEX "idx_mapping_rules_cardcode" ON "mapping_rules"("supplier_cardcode");

-- CreateIndex
CREATE INDEX "idx_mapping_rules_confidence" ON "mapping_rules"("confidence");

-- CreateIndex
CREATE INDEX "idx_audit_log_occurred_at" ON "audit_log"("occurred_at");

-- CreateIndex
CREATE INDEX "idx_audit_log_sap_user" ON "audit_log"("sap_user");

-- CreateIndex
CREATE INDEX "idx_audit_log_action" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "idx_audit_log_entity_id" ON "audit_log"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "pa_channels_name_key" ON "pa_channels"("name");

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_files" ADD CONSTRAINT "invoice_files_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
