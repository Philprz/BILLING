-- Action d'audit pour la rétrogradation manuelle READY → TO_REVIEW
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INVOICE_RETOUR_A_REVISER';
