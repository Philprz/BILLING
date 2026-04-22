import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  computeAmounts,
  generateUblXml,
  type InvoiceGenData,
  type InvoiceGenLine,
} from '../../apps/api/src/services/invoice-generator.service';

// Extrait la valeur texte d'un nœud XML (peut être string ou objet avec #text + attributs)
function textOf(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text']).trim();
  }
  return '';
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseLine: InvoiceGenLine = {
  description: 'Fournitures de bureau',
  quantity: 10,
  unitPrice: 25,
  taxRate: 20,
};

const baseInvoice: InvoiceGenData = {
  invoiceNumber: 'TEST-GEN-001',
  invoiceDate: '2026-04-22',
  dueDate: '2026-05-22',
  currency: 'EUR',
  direction: 'INVOICE',
  supplier: {
    name: 'Acme Fournitures SAS',
    address: '12 Rue du Commerce',
    city: 'Paris',
    postalCode: '75015',
    country: 'FR',
    taxId: 'FR12345678901',
    siret: '12345678901234',
  },
  buyerName: 'DEMO INDUSTRIE SAS',
  lines: [baseLine],
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  isArray: (tagName) => {
    const local = tagName.includes(':') ? tagName.split(':')[1] : tagName;
    return ['InvoiceLine', 'CreditNoteLine', 'TaxSubtotal'].includes(local);
  },
});

// ─── computeAmounts ───────────────────────────────────────────────────────────

describe('computeAmounts', () => {
  it('calcule correctement 1 ligne 20 %', () => {
    const { computedLines, totalExclTax, totalTax, totalInclTax } = computeAmounts([baseLine]);
    expect(computedLines).toHaveLength(1);
    expect(computedLines[0].amountExclTax).toBe(250);
    expect(computedLines[0].taxAmount).toBe(50);
    expect(computedLines[0].amountInclTax).toBe(300);
    expect(totalExclTax).toBe(250);
    expect(totalTax).toBe(50);
    expect(totalInclTax).toBe(300);
  });

  it('calcule correctement plusieurs lignes avec TVA mixte', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'Ligne A', quantity: 2, unitPrice: 100, taxRate: 20 },
      { description: 'Ligne B', quantity: 1, unitPrice: 200, taxRate: 10 },
    ];
    const { totalExclTax, totalTax, totalInclTax } = computeAmounts(lines);
    expect(totalExclTax).toBe(400);
    expect(totalTax).toBe(60);    // 40 + 20
    expect(totalInclTax).toBe(460);
  });

  it('arrondit à 2 décimales', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'Frais', quantity: 3, unitPrice: 0.10, taxRate: 20 },
    ];
    const { computedLines } = computeAmounts(lines);
    expect(computedLines[0].amountExclTax).toBe(0.30);
    expect(computedLines[0].taxAmount).toBe(0.06);
  });

  it('attribue les numéros de ligne en séquence', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'A', quantity: 1, unitPrice: 10, taxRate: 20 },
      { description: 'B', quantity: 1, unitPrice: 20, taxRate: 20 },
      { description: 'C', quantity: 1, unitPrice: 30, taxRate: 20 },
    ];
    const { computedLines } = computeAmounts(lines);
    expect(computedLines.map(l => l.lineNo)).toEqual([1, 2, 3]);
  });
});

// ─── generateUblXml — structure ──────────────────────────────────────────────

describe('generateUblXml — structure XML', () => {
  it('produit un document XML valide parseable', () => {
    const xml = generateUblXml(baseInvoice);
    expect(() => xmlParser.parse(xml)).not.toThrow();
  });

  it('contient le namespace Invoice-2', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
  });

  it('contient les namespaces cac et cbc', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"');
    expect(xml).toContain('xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"');
  });

  it('positionne correctement cbc:ID (numéro facture)', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    expect(String(root['cbc:ID'])).toBe('TEST-GEN-001');
  });

  it('positionne correctement cbc:IssueDate', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    expect(String(root['cbc:IssueDate'])).toBe('2026-04-22');
  });

  it('positionne correctement cbc:DueDate', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    expect(String(root['cbc:DueDate'])).toBe('2026-05-22');
  });

  it('type code 380 pour INVOICE', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
  });

  it('contient le nom du fournisseur', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('Acme Fournitures SAS');
  });

  it('contient le N° TVA fournisseur dans PartyTaxScheme', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const party = (root['cac:AccountingSupplierParty'] as Record<string, unknown>)?.['cac:Party'] as Record<string, unknown>;
    const taxScheme = party?.['cac:PartyTaxScheme'] as Record<string, unknown>;
    expect(String(taxScheme?.['cbc:CompanyID'])).toBe('FR12345678901');
  });

  it('contient LegalMonetaryTotal avec les bons montants', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const monetary = root['cac:LegalMonetaryTotal'] as Record<string, unknown>;
    expect(textOf(monetary['cbc:TaxExclusiveAmount'])).toBe('250.00');
    expect(textOf(monetary['cbc:TaxInclusiveAmount'])).toBe('300.00');
    expect(textOf(monetary['cbc:PayableAmount'])).toBe('300.00');
  });

  it('contient TaxTotal avec le bon montant TVA', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const taxTotal = root['cac:TaxTotal'] as Record<string, unknown>;
    expect(textOf(taxTotal['cbc:TaxAmount'])).toBe('50.00');
  });

  it('produit une ligne InvoiceLine', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const lines = root['cac:InvoiceLine'] as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(String(lines[0]['cbc:ID'])).toBe('1');
    expect(textOf(lines[0]['cbc:LineExtensionAmount'])).toBe('250.00');
  });

  it('échappe les caractères spéciaux XML dans la description', () => {
    const invoice = {
      ...baseInvoice,
      lines: [{ description: 'Test <>&\'"', quantity: 1, unitPrice: 10, taxRate: 20 }],
    };
    const xml = generateUblXml(invoice);
    expect(xml).toContain('Test &lt;&gt;&amp;&apos;&quot;');
    expect(xml).not.toContain('Test <>&');
  });
});

// ─── generateUblXml — CreditNote ─────────────────────────────────────────────

describe('generateUblXml — CreditNote', () => {
  const creditNote: InvoiceGenData = { ...baseInvoice, direction: 'CREDIT_NOTE' };

  it('produit un élément racine CreditNote', () => {
    const xml = generateUblXml(creditNote);
    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
  });

  it('type code 381 pour CREDIT_NOTE', () => {
    const xml = generateUblXml(creditNote);
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
  });

  it('utilise CreditNoteLine au lieu de InvoiceLine', () => {
    const xml = generateUblXml(creditNote);
    expect(xml).toContain('<cac:CreditNoteLine>');
    expect(xml).not.toContain('<cac:InvoiceLine>');
  });

  it('utilise CreditedQuantity au lieu de InvoicedQuantity', () => {
    const xml = generateUblXml(creditNote);
    expect(xml).toContain('<cbc:CreditedQuantity');
    expect(xml).not.toContain('<cbc:InvoicedQuantity');
  });
});

// ─── generateUblXml — cohérence montants ─────────────────────────────────────

describe('generateUblXml — cohérence des montants', () => {
  it('TaxInclusiveAmount = TaxExclusiveAmount + TaxAmount', () => {
    const xml = generateUblXml(baseInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const monetary = root['cac:LegalMonetaryTotal'] as Record<string, unknown>;
    const taxTotal = root['cac:TaxTotal'] as Record<string, unknown>;

    const excl = parseFloat(textOf(monetary['cbc:TaxExclusiveAmount']));
    const tax  = parseFloat(textOf(taxTotal['cbc:TaxAmount']));
    const incl = parseFloat(textOf(monetary['cbc:TaxInclusiveAmount']));

    expect(Math.abs(incl - (excl + tax))).toBeLessThan(0.01);
  });

  it('somme des lignes = LineExtensionAmount global', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'A', quantity: 2, unitPrice: 100, taxRate: 20 },
      { description: 'B', quantity: 3, unitPrice: 50,  taxRate: 20 },
    ];
    const invoice = { ...baseInvoice, lines };
    const xml = generateUblXml(invoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const monetary = root['cac:LegalMonetaryTotal'] as Record<string, unknown>;
    const invoiceLines = root['cac:InvoiceLine'] as Record<string, unknown>[];

    const sumLines = invoiceLines.reduce(
      (acc, l) => acc + parseFloat(textOf(l['cbc:LineExtensionAmount'])),
      0,
    );
    const global = parseFloat(textOf(monetary['cbc:LineExtensionAmount']));

    expect(Math.abs(sumLines - global)).toBeLessThan(0.01);
  });
});

// ─── generateUblXml — parseable par ubl.parser ───────────────────────────────

describe('generateUblXml — compatibilité avec ubl.parser', () => {
  it('le XML généré est parseable par parseUbl sans erreur', async () => {
    // Import dynamique pour ne pas dépendre des modules worker dans les tests API
    const { parseUbl } = await import('../../apps/worker/src/parsers/ubl.parser');
    const xml = generateUblXml(baseInvoice);
    const parsed = parseUbl(xml);

    expect(parsed.docNumberPa).toBe('TEST-GEN-001');
    expect(parsed.docDate).toBe('2026-04-22');
    expect(parsed.dueDate).toBe('2026-05-22');
    expect(parsed.currency).toBe('EUR');
    expect(parsed.supplierNameRaw).toBe('Acme Fournitures SAS');
    expect(parsed.supplierPaIdentifier).toBe('FR12345678901');
    expect(parsed.direction).toBe('INVOICE');
    expect(parsed.totalExclTax).toBe('250.00');
    expect(parsed.totalInclTax).toBe('300.00');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].description).toBe('Fournitures de bureau');
  });

  it('le XML CreditNote est parseable par parseUbl', async () => {
    const { parseUbl } = await import('../../apps/worker/src/parsers/ubl.parser');
    const xml = generateUblXml({ ...baseInvoice, direction: 'CREDIT_NOTE' });
    const parsed = parseUbl(xml);
    expect(parsed.direction).toBe('CREDIT_NOTE');
  });
});
