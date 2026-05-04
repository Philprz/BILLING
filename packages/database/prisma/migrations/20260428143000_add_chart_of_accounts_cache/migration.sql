CREATE TABLE "chart_of_accounts_cache" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "acct_code" TEXT NOT NULL,
    "acct_name" TEXT NOT NULL,
    "active_account" BOOLEAN NOT NULL DEFAULT false,
    "postable" BOOLEAN NOT NULL DEFAULT false,
    "account_level" INTEGER,
    "group_mask" INTEGER,
    "sync_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_of_accounts_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chart_of_accounts_cache_acct_code_key" ON "chart_of_accounts_cache"("acct_code");
CREATE INDEX "idx_chart_accounts_name" ON "chart_of_accounts_cache"("acct_name");
CREATE INDEX "idx_chart_accounts_usable" ON "chart_of_accounts_cache"("active_account", "postable");
