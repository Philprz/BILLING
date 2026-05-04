-- Contrainte d'unicité métier : un numéro de document ne peut exister qu'une seule fois
-- pour un fournisseur donné, quel que soit le canal d'entrée (PA, upload manuel, etc.)
-- Nettoyer les doublons existants avant d'appliquer si nécessaire.
ALTER TABLE "invoices" ADD CONSTRAINT "uq_invoices_doc_supplier" UNIQUE ("doc_number_pa", "supplier_pa_identifier");
