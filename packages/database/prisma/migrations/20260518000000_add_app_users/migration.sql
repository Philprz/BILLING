-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ACCOUNTANT', 'VIEWER');

-- CreateTable
CREATE TABLE "app_users" (
    "id" UUID NOT NULL,
    "sap_username" TEXT NOT NULL,
    "company_db" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_users_sap_username_company_db_key" ON "app_users"("sap_username", "company_db");

-- CreateIndex
CREATE INDEX "idx_app_users_sap_username" ON "app_users"("sap_username");
