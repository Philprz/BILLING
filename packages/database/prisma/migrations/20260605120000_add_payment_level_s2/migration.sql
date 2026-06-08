-- Niveau payé (matrice S/B 2) — paiement sortant + lettrage (A) & suivi U_NOVA_Statut (B).
-- Colonnes additives nullables uniquement (aucune donnée existante impactée, aucune contrainte NOT NULL).
-- `migrate deploy`-safe : pas d'ALTER TYPE, pas de backfill.

-- (A) Résultat du paiement sortant NOVA (OutgoingPayments). Idempotence applicative : un seul paiement par facture.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sap_payment_doc_entry" INTEGER;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sap_payment_doc_num" INTEGER;

-- (B) Miroir base du suivi U_NOVA_Statut (échelle NON_PAYE<PROGRAMME<PARTIEL<PAYE<SOLDE).
-- Stocké en texte (valeurs de l'échelle) — pas d'enum Postgres pour éviter un ALTER TYPE à chaque évolution d'échelle.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "nova_payment_status" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "nova_payment_status_source" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "nova_payment_status_at" TIMESTAMPTZ(6);

-- (B) Candidat de consolidation issu du cycle de vie réforme (source PA), distinct de l'état dérivé SAP.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "pa_payment_status" TEXT;

-- Index de sélection du job de suivi : factures intégrées non encore SOLDE.
CREATE INDEX IF NOT EXISTS "idx_invoices_nova_payment_status" ON "invoices"("nova_payment_status");
