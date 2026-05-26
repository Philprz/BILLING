import { describe, expect, it } from 'vitest';
import { extractInvoiceLines } from '../../apps/worker/src/parsers/pdf-lines';

// Texte extrait par pdf-parse pour une facture fournisseur générée par
// BILLING : les cellules d'une même ligne du tableau sont concaténées sans
// séparateur. Mélange TVA 20 % + TVA 0 % (exonération bancaire, art. 261 C CGI).
const RAW_PDF_TEXT = `DescriptionQtéP.U. HTHTTVATTC
Frais de tenue de compte — 1er trimestre 20261180.00180.0020%216.00
Intérêts sur emprunt professionnel — avril 202611240.001240.000%1240.00
TVA
TVA 20% [S — Standard] — Base : 180.00 — TVA : 36.00 EUR
TVA 0% [E — Exonéré] — Base : 1240.00 — TVA : 0.00 EUR
Total HT1420.00 EUR
TVA totale36.00 EUR
TOTAL TTC1456.00 EUR
`;

// Facture 100 % hors champ TVA : taxes locales (taxe foncière, CFE), toutes
// les lignes à 0 %. Cas réel rencontré sur les avis d'imposition refacturés.
const RAW_PDF_TEXT_HORS_CHAMP = `DescriptionQtéP.U. HTHTTVATTC
Taxe foncière — exercice 202614200.004200.000%4200.00
Cotisation foncière des entreprises (CFE) — 202611850.001850.000%1850.00
TVA
TVA 0% [O — Hors champ TVA] — Base : 6050.00 — TVA : 0.00 EUR
Total HT6050.00 EUR
TVA totale0.00 EUR
TOTAL TTC6050.00 EUR
`;

describe('extractInvoiceLines', () => {
  it('extrait les lignes mêlant TVA à 20 % et TVA à 0 %', () => {
    const result = extractInvoiceLines(RAW_PDF_TEXT);

    expect(result.lines).toHaveLength(2);
    expect(result.sumExclTax).toBeCloseTo(1420, 2);

    expect(result.lines[0]).toMatchObject({
      lineNo: 1,
      description: 'Frais de tenue de compte — 1er trimestre 2026',
      quantity: '1',
      unitPrice: '180.00',
      amountExclTax: '180.00',
      taxRate: '20.00',
      amountInclTax: '216.00',
    });

    expect(result.lines[1]).toMatchObject({
      lineNo: 2,
      description: 'Intérêts sur emprunt professionnel — avril 2026',
      quantity: '1',
      unitPrice: '1240.00',
      amountExclTax: '1240.00',
      taxRate: '0.00',
      amountInclTax: '1240.00',
    });
  });

  it("extrait les lignes d'une facture 100 % hors champ TVA (toutes lignes à 0 %)", () => {
    const result = extractInvoiceLines(RAW_PDF_TEXT_HORS_CHAMP);

    expect(result.lines).toHaveLength(2);
    expect(result.sumExclTax).toBeCloseTo(6050, 2);

    expect(result.lines[0]).toMatchObject({
      lineNo: 1,
      description: 'Taxe foncière — exercice 2026',
      quantity: '1',
      unitPrice: '4200.00',
      amountExclTax: '4200.00',
      taxRate: '0.00',
      taxAmount: '0.00',
      amountInclTax: '4200.00',
    });

    expect(result.lines[1]).toMatchObject({
      lineNo: 2,
      description: 'Cotisation foncière des entreprises (CFE) — 2026',
      quantity: '1',
      unitPrice: '1850.00',
      amountExclTax: '1850.00',
      taxRate: '0.00',
      taxAmount: '0.00',
      amountInclTax: '1850.00',
    });
  });
});
