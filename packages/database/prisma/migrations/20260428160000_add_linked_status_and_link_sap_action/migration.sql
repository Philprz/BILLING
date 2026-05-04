-- AlterEnum : ajout du statut LINKED (Voie B — rattachement facture SAP manuelle)
ALTER TYPE "InvoiceStatus" ADD VALUE 'LINKED';

-- AlterEnum : ajout de l'action d'audit LINK_SAP (Voie B)
ALTER TYPE "AuditAction" ADD VALUE 'LINK_SAP';
