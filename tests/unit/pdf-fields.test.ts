import { describe, expect, it } from 'vitest';
import { extractInvoiceFields } from '../../apps/worker/src/parsers/pdf-fields';

// Texte tel que pdf-parse l'extrait des PDF générés par BILLING (bloc
// FOURNISSEUR sur la gauche, bloc ACHETEUR/FACTURE sur la droite, restitués
// séquentiellement). Le cas qui nous intéresse : fournisseur SANS SIRET (n°
// TVA seul) et acheteur avec SIRET. Sans scoping, l'ancien parser remontait
// le SIRET de l'acheteur (bug PA réel).
const RAW_PDF_TEXT_VAT_ONLY_SUPPLIER = `FACTURE FOURNISSEUR
FOURNISSEUR
TRESORERIE DES IMPOTS
EPIC
1 rue de la Préfecture
75001 PARIS
TVA   : FR90130004955
Tél.  : 0140123456
Email : contact@dgfip.gouv.fr
FACTURE
Numéro : F2026-00042
Date d'émission : 2026-05-22
Date d'échéance : 2026-06-30
Devise : EUR
ACHETEUR
DEMO INDUSTRIE SAS
SAS
12 avenue des Champs
75008 PARIS
SIRET : 40483304800022
TVA   : FR12404833048
DescriptionQtéP.U. HTHTTVATTC
Taxe foncière — exercice 202614200.004200.000%4200.00
TVA
TVA 0% [O — Hors champ TVA] — Base : 4200.00 — TVA : 0.00 EUR
Total HT4200.00 EUR
TVA totale0.00 EUR
TOTAL TTC4200.00 EUR
`;

const RAW_PDF_TEXT_SUPPLIER_WITH_SIRET = `FACTURE FOURNISSEUR
FOURNISSEUR
ALPHA SERVICES SARL
SARL
1 rue Alpha
75001 PARIS
SIRET : 12345678900012
TVA   : FR40123456789
FACTURE
Numéro : F2026-00100
Date d'émission : 2026-05-22
ACHETEUR
DEMO INDUSTRIE SAS
SIRET : 40483304800022
DescriptionQtéP.U. HTHTTVATTC
Conseil1500.00500.0020%600.00
TVA
TVA 20% — Base : 500.00 — TVA : 100.00 EUR
Total HT500.00 EUR
TVA totale100.00 EUR
TOTAL TTC600.00 EUR
`;

describe('extractInvoiceFields', () => {
  it("extrait le n° TVA du FOURNISSEUR (pas le SIRET de l'ACHETEUR) quand le fournisseur n'a pas de SIRET", () => {
    const fields = extractInvoiceFields(RAW_PDF_TEXT_VAT_ONLY_SUPPLIER);

    expect(fields.supplierPaIdentifier).toBe('FR90130004955');
    expect(fields.supplierPaIdentifier).not.toBe('40483304800022');
    expect(fields.supplierNameRaw).toBe('TRESORERIE DES IMPOTS');
    expect(fields.confidence.supplier).toBeGreaterThanOrEqual(90);
  });

  it("préfère le SIRET du fournisseur quand il existe, et ignore le SIRET de l'acheteur", () => {
    const fields = extractInvoiceFields(RAW_PDF_TEXT_SUPPLIER_WITH_SIRET);

    expect(fields.supplierPaIdentifier).toBe('12345678900012');
    expect(fields.supplierNameRaw).toBe('ALPHA SERVICES SARL');
    expect(fields.confidence.supplier).toBe(95);
  });

  it('renvoie une chaîne vide quand le bloc FOURNISSEUR est introuvable (plutôt que le SIRET acheteur)', () => {
    const noSupplierBlock = `FACTURE
Numéro : F2026-00200
ACHETEUR
DEMO INDUSTRIE SAS
SIRET : 40483304800022
`;
    const fields = extractInvoiceFields(noSupplierBlock);
    expect(fields.supplierPaIdentifier).toBe('');
    expect(fields.supplierNameRaw).toBe('');
  });
});
