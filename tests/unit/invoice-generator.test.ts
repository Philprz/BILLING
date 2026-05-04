import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  computeAmounts,
  generateUblXml,
  validateExpenseLines,
  createZipBuffer,
  InvoiceValidationError,
  type InvoiceGenData,
  type InvoiceGenLine,
} from '../../apps/api/src/services/invoice-generator.service';

// Extrait la valeur texte d'un nœud XML
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
  accountingCode: '606400',
  accountingLabel: 'Fournitures administratives',
};

const baseInvoice: InvoiceGenData = {
  invoiceNumber: 'TEST-GEN-001',
  invoiceDate: '2026-04-22',
  dueDate: '2026-05-22',
  currency: 'EUR',
  direction: 'INVOICE',
  supplier: {
    name: 'Acme Fournitures SAS',
    legalForm: 'SAS au capital de 50 000 EUR',
    address: '12 Rue du Commerce',
    city: 'Paris',
    postalCode: '75015',
    country: 'FR',
    taxId: 'FR12345678901',
    siret: '12345678901234',
    iban: 'FR76 3000 6000 0112 3456 7890 189',
    bic: 'AGRIFRPP',
    phone: '01 42 68 90 11',
    email: 'facturation@acme.fr',
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
      {
        description: 'Ligne A',
        quantity: 2,
        unitPrice: 100,
        taxRate: 20,
        accountingCode: '622600',
      },
      {
        description: 'Ligne B',
        quantity: 1,
        unitPrice: 200,
        taxRate: 10,
        accountingCode: '613200',
      },
    ];
    const { totalExclTax, totalTax, totalInclTax } = computeAmounts(lines);
    expect(totalExclTax).toBe(400);
    expect(totalTax).toBe(60); // 40 + 20
    expect(totalInclTax).toBe(460);
  });

  it('arrondit à 2 décimales', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'Frais', quantity: 3, unitPrice: 0.1, taxRate: 20, accountingCode: '627000' },
    ];
    const { computedLines } = computeAmounts(lines);
    expect(computedLines[0].amountExclTax).toBe(0.3);
    expect(computedLines[0].taxAmount).toBe(0.06);
  });

  it('attribue les numéros de ligne en séquence', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'A', quantity: 1, unitPrice: 10, taxRate: 20, accountingCode: '606400' },
      { description: 'B', quantity: 1, unitPrice: 20, taxRate: 20, accountingCode: '622600' },
      { description: 'C', quantity: 1, unitPrice: 30, taxRate: 20, accountingCode: '613200' },
    ];
    const { computedLines } = computeAmounts(lines);
    expect(computedLines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });
});

// ─── validateExpenseLines ─────────────────────────────────────────────────────

describe('validateExpenseLines', () => {
  it('accepte des lignes avec comptes classe 6 valides', () => {
    expect(() =>
      validateExpenseLines([
        { description: 'A', quantity: 1, unitPrice: 10, taxRate: 20, accountingCode: '606400' },
        { description: 'B', quantity: 1, unitPrice: 20, taxRate: 20, accountingCode: '622600' },
        { description: 'C', quantity: 1, unitPrice: 30, taxRate: 0, accountingCode: '635000' },
      ]),
    ).not.toThrow();
  });

  it('lève InvoiceValidationError si le compte est absent', () => {
    expect(() =>
      validateExpenseLines([
        { description: 'Sans compte', quantity: 1, unitPrice: 10, taxRate: 20, accountingCode: '' },
      ]),
    ).toThrow(InvoiceValidationError);
  });

  it('lève InvoiceValidationError si le compte ne commence pas par 6', () => {
    expect(() =>
      validateExpenseLines([
        { description: 'Vente', quantity: 1, unitPrice: 10, taxRate: 20, accountingCode: '701000' },
      ]),
    ).toThrow(InvoiceValidationError);
  });

  it("message d'erreur identifie la ligne fautive", () => {
    let msg = '';
    try {
      validateExpenseLines([
        {
          description: 'Immo machine',
          quantity: 1,
          unitPrice: 10,
          taxRate: 20,
          accountingCode: '215000',
        },
      ]);
    } catch (e) {
      if (e instanceof InvoiceValidationError) msg = e.message;
    }
    expect(msg).toContain('Immo machine');
    expect(msg).toContain('215000');
  });

  it('refuse un compte de stock (3xx)', () => {
    expect(() =>
      validateExpenseLines([
        {
          description: 'Stock marchandises',
          quantity: 1,
          unitPrice: 10,
          taxRate: 20,
          accountingCode: '370000',
        },
      ]),
    ).toThrow(InvoiceValidationError);
  });

  it('refuse un compte de produit (7xx)', () => {
    expect(() =>
      validateExpenseLines([
        {
          description: 'Produit vente',
          quantity: 1,
          unitPrice: 10,
          taxRate: 20,
          accountingCode: '707000',
        },
      ]),
    ).toThrow(InvoiceValidationError);
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
    expect(xml).toContain(
      'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    );
    expect(xml).toContain(
      'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    );
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
    const party = (root['cac:AccountingSupplierParty'] as Record<string, unknown>)?.[
      'cac:Party'
    ] as Record<string, unknown>;
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
      lines: [
        {
          description: 'Test <>&\'"',
          quantity: 1,
          unitPrice: 10,
          taxRate: 20,
          accountingCode: '606400',
        },
      ],
    };
    const xml = generateUblXml(invoice);
    expect(xml).toContain('Test &lt;&gt;&amp;&apos;&quot;');
    expect(xml).not.toContain('Test <>&');
  });
});

// ─── generateUblXml — AccountingCost (compte classe 6) ───────────────────────

describe('generateUblXml — AccountingCost classe 6', () => {
  it('insère cbc:AccountingCost dans chaque InvoiceLine', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('<cbc:AccountingCost>606400</cbc:AccountingCost>');
  });

  it('AccountingCost correspond au code saisi', () => {
    const invoice = {
      ...baseInvoice,
      lines: [
        {
          description: 'Honoraires',
          quantity: 1,
          unitPrice: 500,
          taxRate: 20,
          accountingCode: '622600',
        },
      ],
    };
    const xml = generateUblXml(invoice);
    expect(xml).toContain('<cbc:AccountingCost>622600</cbc:AccountingCost>');
  });

  it('AccountingCost multi-lignes — chaque ligne a son propre code', () => {
    const invoice = {
      ...baseInvoice,
      lines: [
        {
          description: 'Fournitures',
          quantity: 1,
          unitPrice: 100,
          taxRate: 20,
          accountingCode: '606400',
        },
        {
          description: 'Maintenance',
          quantity: 1,
          unitPrice: 200,
          taxRate: 20,
          accountingCode: '615000',
        },
        {
          description: 'Transport',
          quantity: 1,
          unitPrice: 300,
          taxRate: 20,
          accountingCode: '624000',
        },
      ],
    };
    const xml = generateUblXml(invoice);
    expect(xml).toContain('<cbc:AccountingCost>606400</cbc:AccountingCost>');
    expect(xml).toContain('<cbc:AccountingCost>615000</cbc:AccountingCost>');
    expect(xml).toContain('<cbc:AccountingCost>624000</cbc:AccountingCost>');
  });

  it('pas de AccountingCost dans InvoiceLine si le champ est absent de la ligne', () => {
    const lineNoCode: InvoiceGenLine = {
      description: 'Test',
      quantity: 1,
      unitPrice: 10,
      taxRate: 20,
    };
    const xml = generateUblXml({ ...baseInvoice, lines: [lineNoCode] });
    // generateUblXml n'exige pas le code (validation dans generateAndSave)
    // La balise racine AccountingCost peut être présente (header), mais pas dans InvoiceLine
    const lineStart = xml.indexOf('<cac:InvoiceLine>');
    const lineEnd = xml.indexOf('</cac:InvoiceLine>');
    const lineXml = lineStart >= 0 ? xml.substring(lineStart, lineEnd) : '';
    expect(lineXml).not.toContain('<cbc:AccountingCost>');
  });

  it('facteur de conformité UBL : AccountingCost est positionné avant cac:Item', () => {
    const xml = generateUblXml(baseInvoice);
    const accPos = xml.indexOf('<cbc:AccountingCost>');
    const itemPos = xml.indexOf('<cac:Item>');
    expect(accPos).toBeGreaterThan(0);
    expect(accPos).toBeLessThan(itemPos);
  });
});

// ─── generateUblXml — PaymentMeans IBAN ──────────────────────────────────────

describe('generateUblXml — PaymentMeans IBAN', () => {
  it("contient cac:PaymentMeans avec l'IBAN fournisseur", () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('FR76 3000 6000 0112 3456 7890 189');
  });

  it('contient le BIC', () => {
    const xml = generateUblXml(baseInvoice);
    expect(xml).toContain('AGRIFRPP');
  });

  it('pas de cac:PaymentMeans si IBAN absent', () => {
    const noIban = {
      ...baseInvoice,
      supplier: { ...baseInvoice.supplier, iban: undefined, bic: undefined },
    };
    const xml = generateUblXml(noIban);
    expect(xml).not.toContain('<cac:PaymentMeans>');
  });
});

// ─── generateUblXml — CreditNote ─────────────────────────────────────────────

describe('generateUblXml — CreditNote', () => {
  const creditNote: InvoiceGenData = { ...baseInvoice, direction: 'CREDIT_NOTE' };

  it('produit un élément racine CreditNote', () => {
    const xml = generateUblXml(creditNote);
    expect(xml).toContain(
      '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    );
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
    const tax = parseFloat(textOf(taxTotal['cbc:TaxAmount']));
    const incl = parseFloat(textOf(monetary['cbc:TaxInclusiveAmount']));

    expect(Math.abs(incl - (excl + tax))).toBeLessThan(0.01);
  });

  it('somme des lignes = LineExtensionAmount global', () => {
    const lines: InvoiceGenLine[] = [
      { description: 'A', quantity: 2, unitPrice: 100, taxRate: 20, accountingCode: '622600' },
      { description: 'B', quantity: 3, unitPrice: 50, taxRate: 20, accountingCode: '613200' },
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

  it('facture charges 60 — calcul HT/TVA/TTC correct', () => {
    const inv: InvoiceGenData = {
      ...baseInvoice,
      lines: [
        {
          description: 'Carburant',
          quantity: 100,
          unitPrice: 1.85,
          taxRate: 20,
          accountingCode: '606300',
        },
        { description: 'Eau', quantity: 1, unitPrice: 320, taxRate: 5.5, accountingCode: '606100' },
      ],
    };
    const { totalExclTax, totalTax, totalInclTax } = computeAmounts(inv.lines);
    expect(totalExclTax).toBe(round2(185 + 320));
    expect(Math.abs(totalTax - round2(185 * 0.2 + 320 * 0.055))).toBeLessThan(0.02);
    expect(Math.abs(totalInclTax - (totalExclTax + totalTax))).toBeLessThan(0.01);

    const xml = generateUblXml(inv);
    expect(xml).toContain('<cbc:AccountingCost>606300</cbc:AccountingCost>');
    expect(xml).toContain('<cbc:AccountingCost>606100</cbc:AccountingCost>');
  });

  it('facture services 61/62 — XML parseable et AccountingCost présent', () => {
    const inv: InvoiceGenData = {
      ...baseInvoice,
      lines: [
        {
          description: 'Location bureaux',
          quantity: 1,
          unitPrice: 2400,
          taxRate: 20,
          accountingCode: '613200',
        },
        {
          description: 'Honoraires',
          quantity: 1,
          unitPrice: 1800,
          taxRate: 20,
          accountingCode: '622600',
        },
      ],
    };
    const xml = generateUblXml(inv);
    expect(() => xmlParser.parse(xml)).not.toThrow();
    expect(xml).toContain('613200');
    expect(xml).toContain('622600');
  });

  it('facture taxe 63 — TVA 0% correcte', () => {
    const inv: InvoiceGenData = {
      ...baseInvoice,
      lines: [
        {
          description: 'Taxe foncière',
          quantity: 1,
          unitPrice: 4200,
          taxRate: 0,
          accountingCode: '635100',
        },
      ],
    };
    const xml = generateUblXml(inv);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const taxTotal = root['cac:TaxTotal'] as Record<string, unknown>;
    expect(textOf(taxTotal['cbc:TaxAmount'])).toBe('0.00');
    expect(xml).toContain('635100');
  });
});

// ─── generateUblXml — parseable par ubl.parser ───────────────────────────────

describe('generateUblXml — compatibilité avec ubl.parser', () => {
  it('le XML généré est parseable par parseUbl sans erreur', async () => {
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

  it('XML avec AccountingCost est parseable sans erreur', async () => {
    const { parseUbl } = await import('../../apps/worker/src/parsers/ubl.parser');
    const inv = {
      ...baseInvoice,
      lines: [
        {
          description: 'Honoraires',
          quantity: 1,
          unitPrice: 1000,
          taxRate: 20,
          accountingCode: '622600',
        },
        {
          description: 'Location',
          quantity: 1,
          unitPrice: 2000,
          taxRate: 20,
          accountingCode: '613200',
        },
      ],
    };
    const xml = generateUblXml(inv);
    expect(() => parseUbl(xml)).not.toThrow();
  });
});

// ─── createZipBuffer ─────────────────────────────────────────────────────────

describe('createZipBuffer', () => {
  it('produit un Buffer non vide', () => {
    const buf = createZipBuffer([
      { name: 'test.xml', data: Buffer.from('<Invoice/>') },
      { name: 'test.pdf', data: Buffer.from('%PDF-1.4') },
    ]);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('commence par la signature ZIP (PK\\x03\\x04)', () => {
    const buf = createZipBuffer([{ name: 'file.txt', data: Buffer.from('hello') }]);
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('contient la signature End of Central Directory (PK\\x05\\x06)', () => {
    const buf = createZipBuffer([{ name: 'invoice.xml', data: Buffer.from('<Invoice/>') }]);
    // Cherche 0x504b0506 dans le buffer
    let found = false;
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('contient les données brutes des fichiers', () => {
    const xmlData = Buffer.from('<Invoice><cbc:ID>TEST</cbc:ID></Invoice>');
    const buf = createZipBuffer([{ name: 'inv.xml', data: xmlData }]);
    // Les données STORE sont non compressées → présentes telles quelles
    expect(buf.indexOf(xmlData)).toBeGreaterThan(0);
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
