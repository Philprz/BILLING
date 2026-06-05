import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  computeAmounts,
  computeAmountsForData,
  computePeppolRoutable,
  computeCadre,
  documentTypeCode,
  directionLabel,
  generateUblXml,
  validateExpenseLines,
  validateAllowanceCharges,
  validatePayee,
  resolveNotes,
  isConfirmedNoteSubjectCode,
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
    return ['InvoiceLine', 'CreditNoteLine', 'TaxSubtotal', 'AllowanceCharge', 'Note'].includes(
      local,
    );
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
    expect(parsed.supplierPaIdentifier).toBe('12345678901234');
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

// ─── Cadre de facturation BT-23 (matrice B/S/M × 1/2/4) ──────────────────────

describe('computeCadre — lettre B/S/M', () => {
  const svcLine: InvoiceGenLine = {
    description: 'Prestation',
    quantity: 1,
    unitPrice: 100,
    taxRate: 20,
    accountingCode: '622600',
  };
  const goodLine: InvoiceGenLine = {
    description: 'Fournitures',
    quantity: 1,
    unitPrice: 100,
    taxRate: 20,
    accountingCode: '606400',
  };

  it('classe 60 → Bien', () => {
    expect(computeCadre({ ...baseInvoice, lines: [goodLine] }).letter).toBe('B');
  });

  it('classe 62 → Service', () => {
    expect(computeCadre({ ...baseInvoice, lines: [svcLine] }).letter).toBe('S');
  });

  it('classe 63-67 → Service (défaut frais généraux)', () => {
    const tax: InvoiceGenLine = { ...svcLine, accountingCode: '635100' };
    const perso: InvoiceGenLine = { ...svcLine, accountingCode: '645000' };
    expect(computeCadre({ ...baseInvoice, lines: [tax] }).letter).toBe('S');
    expect(computeCadre({ ...baseInvoice, lines: [perso] }).letter).toBe('S');
  });

  it('mélange Biens + Services → M', () => {
    expect(computeCadre({ ...baseInvoice, lines: [goodLine, svcLine] }).letter).toBe('M');
  });
});

describe('computeCadre — chiffre 1/2/4', () => {
  const svc: InvoiceGenLine = {
    description: 'Prestation',
    quantity: 1,
    unitPrice: 100,
    taxRate: 20,
    accountingCode: '622600',
  };
  const base = { ...baseInvoice, lines: [svc] };

  it('380 non payée → 1 (S1)', () => {
    const c = computeCadre({ ...base, direction: 'INVOICE', paymentStatus: 'unpaid' });
    expect(c.code).toBe('S1');
    expect(c.digit).toBe('1');
  });

  it('380 déjà payée → 2 (S2)', () => {
    const c = computeCadre({ ...base, direction: 'INVOICE', paymentStatus: 'paid' });
    expect(c.code).toBe('S2');
  });

  it('380 avec acompte (prepaidAmount > 0) → 4 (définitive après acompte)', () => {
    const goods = { ...svc, accountingCode: '606400' };
    const c = computeCadre({
      ...base,
      lines: [goods],
      direction: 'INVOICE',
      prepaidAmount: 1000,
    });
    expect(c.code).toBe('B4');
  });

  it('386 (acompte) ne produit JAMAIS 4, même avec prepaidAmount', () => {
    const c = computeCadre({ ...base, direction: 'ADVANCE_INVOICE', prepaidAmount: 5000 });
    expect(c.digit).not.toBe('4');
    expect(c.code).toBe('S1');
  });

  it('381 (avoir) non payé → 1, jamais 4', () => {
    const c = computeCadre({ ...base, direction: 'CREDIT_NOTE', paymentStatus: 'unpaid' });
    expect(c.code).toBe('S1');
  });

  it("503 (avoir d'acompte) → jamais 4", () => {
    const c = computeCadre({
      ...base,
      direction: 'ADVANCE_CREDIT_NOTE',
      prepaidAmount: 5000,
      paymentStatus: 'paid',
    });
    expect(c.digit).not.toBe('4');
    expect(c.code).toBe('S2');
  });

  it('384 (rectificative) suit la famille commerciale : S1 / S2 / B4 si acompte', () => {
    // Non payée → S1
    expect(computeCadre({ ...base, direction: 'CORRECTIVE_INVOICE' }).code).toBe('S1');
    // Déjà payée → S2
    expect(
      computeCadre({ ...base, direction: 'CORRECTIVE_INVOICE', paymentStatus: 'paid' }).code,
    ).toBe('S2');
    // Acompte (prepaidAmount > 0) sur lignes Biens → B4 (comme un 380)
    const goods = { ...svc, accountingCode: '606400' };
    const c = computeCadre({
      ...base,
      lines: [goods],
      direction: 'CORRECTIVE_INVOICE',
      prepaidAmount: 1000,
    });
    expect(c.code).toBe('B4');
    expect(c.digit).toBe('4');
  });
});

describe('computeCadre — contrôle de cohérence typeTransaction', () => {
  it('aucune divergence si typeTransaction concorde avec les lignes', () => {
    const svc: InvoiceGenLine = {
      description: 'Prestation',
      quantity: 1,
      unitPrice: 100,
      taxRate: 20,
      accountingCode: '622600',
    };
    const c = computeCadre({ ...baseInvoice, lines: [svc], typeTransaction: '2' });
    expect(c.divergence).toBe(false);
  });

  it('divergence si lignes Services mais typeTransaction = 1 (Biens)', () => {
    const svc: InvoiceGenLine = {
      description: 'Prestation',
      quantity: 1,
      unitPrice: 100,
      taxRate: 20,
      accountingCode: '622600',
    };
    const c = computeCadre({ ...baseInvoice, lines: [svc], typeTransaction: '1' });
    expect(c.divergence).toBe(true);
    expect(c.inferredLetter).toBe('S'); // valeur émise = inférée des lignes
    expect(c.letter).toBe('S');
    expect(c.transactionLetter).toBe('B');
  });

  it('pas de divergence si typeTransaction absent', () => {
    const c = computeCadre({ ...baseInvoice, typeTransaction: undefined });
    expect(c.divergence).toBe(false);
  });
});

describe('documentTypeCode — BT-3', () => {
  it('mappe chaque direction au bon code', () => {
    expect(documentTypeCode('INVOICE')).toBe('380');
    expect(documentTypeCode('CREDIT_NOTE')).toBe('381');
    expect(documentTypeCode('CORRECTIVE_INVOICE')).toBe('384');
    expect(documentTypeCode('ADVANCE_INVOICE')).toBe('386');
    expect(documentTypeCode('ADVANCE_CREDIT_NOTE')).toBe('503');
    expect(documentTypeCode('SELF_BILLED')).toBe('389');
    expect(documentTypeCode('FACTORING')).toBe('393');
  });
});

describe('generateUblXml — ProfileID = cadre BT-23', () => {
  const svc: InvoiceGenLine = {
    description: 'Prestation',
    quantity: 1,
    unitPrice: 100,
    taxRate: 20,
    accountingCode: '622600',
  };

  it("émet le code court dans cbc:ProfileID (et non plus l'URN Peppol)", () => {
    const xml = generateUblXml({ ...baseInvoice, lines: [svc], paymentStatus: 'unpaid' });
    expect(xml).toContain('<cbc:ProfileID>S1</cbc:ProfileID>');
    expect(xml).not.toContain('urn:fdc:peppol.eu:2017:poacc:billing:01:1.0');
  });

  it('CustomizationID (BT-24) reste inchangé', () => {
    const xml = generateUblXml({ ...baseInvoice, lines: [svc] });
    expect(xml).toContain(
      '<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>',
    );
  });

  it('M2 pour mélange biens+services déjà payé', () => {
    const goods: InvoiceGenLine = { ...svc, accountingCode: '606400' };
    const xml = generateUblXml({
      ...baseInvoice,
      lines: [goods, svc],
      paymentStatus: 'paid',
    });
    expect(xml).toContain('<cbc:ProfileID>M2</cbc:ProfileID>');
  });

  it('B4 pour facture définitive après acompte sur des biens', () => {
    const goods: InvoiceGenLine = { ...svc, accountingCode: '606400' };
    const xml = generateUblXml({ ...baseInvoice, lines: [goods], prepaidAmount: 500 });
    expect(xml).toContain('<cbc:ProfileID>B4</cbc:ProfileID>');
  });

  it('503 produit un document CreditNote', () => {
    const xml = generateUblXml({ ...baseInvoice, lines: [svc], direction: 'ADVANCE_CREDIT_NOTE' });
    expect(xml).toContain('<cbc:CreditNoteTypeCode>503</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('<cac:CreditNoteLine>');
  });
});

// ─── BR-FR-CO-09 — facture déjà payée (cadre chiffre 2) ──────────────────────
// AFNOR XP Z12-012 : pour un cadre chiffre 2 (B2/S2/M2), BT-113 PrepaidAmount = BT-112 TTC,
// BT-115 PayableAmount = 0, BT-9 DueDate = date de paiement.

describe('BR-FR-CO-09 — montants facture déjà payée (chiffre 2)', () => {
  // 1 prestation à 100 HT, 20 % → TTC 120. accountingCode 622600 → service (lettre S).
  const svc: InvoiceGenLine = {
    description: 'Prestation',
    quantity: 1,
    unitPrice: 100,
    taxRate: 20,
    accountingCode: '622600',
  };
  const paid: InvoiceGenData = {
    ...baseInvoice,
    lines: [svc],
    paymentStatus: 'paid',
    paymentDate: '2026-04-25',
  };

  const monetaryOf = (xml: string) => {
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    return {
      root,
      monetary: root['cac:LegalMonetaryTotal'] as Record<string, unknown>,
    };
  };

  it('cadre S2 → PrepaidAmount = TTC, PayableAmount = 0, DueDate = paymentDate', () => {
    expect(computeCadre(paid).code).toBe('S2');
    const xml = generateUblXml(paid);
    const { root, monetary } = monetaryOf(xml);
    expect(textOf(monetary['cbc:TaxInclusiveAmount'])).toBe('120.00');
    expect(textOf(monetary['cbc:PrepaidAmount'])).toBe('120.00');
    expect(textOf(monetary['cbc:PayableAmount'])).toBe('0.00');
    expect(String(root['cbc:DueDate'])).toBe('2026-04-25');
  });

  it('payée sans paymentDate → DueDate = invoiceDate', () => {
    const xml = generateUblXml({ ...paid, paymentDate: undefined });
    const { root, monetary } = monetaryOf(xml);
    expect(textOf(monetary['cbc:PayableAmount'])).toBe('0.00');
    expect(String(root['cbc:DueDate'])).toBe(baseInvoice.invoiceDate); // 2026-04-22
  });

  it('computeAmountsForData reflète prepaid=TTC et payable=0 pour le chiffre 2', () => {
    const amounts = computeAmountsForData(paid);
    expect(amounts.taxInclusiveAmount).toBe(120);
    expect(amounts.prepaidAmount).toBe(120);
    expect(amounts.payableAmount).toBe(0);
  });

  it('non payée (chiffre 1) → S1, pas de prepaid forcé, PayableAmount = TTC', () => {
    const unpaid: InvoiceGenData = { ...paid, paymentStatus: 'unpaid', paymentDate: undefined };
    expect(computeCadre(unpaid).code).toBe('S1');
    const xml = generateUblXml(unpaid);
    const { root, monetary } = monetaryOf(xml);
    expect(textOf(monetary['cbc:PrepaidAmount'])).toBe('0.00');
    expect(textOf(monetary['cbc:PayableAmount'])).toBe('120.00');
    // DueDate inchangé = dueDate saisi
    expect(String(root['cbc:DueDate'])).toBe(baseInvoice.dueDate);
  });

  it('acompte (chiffre 4) → CO-09 ne s’applique pas : prepaid partiel, payable = TTC − acompte', () => {
    // prepaidAmount d'entrée > 0 → chiffre 4 ; paymentStatus paid ne doit pas écraser le prepaid.
    const advance: InvoiceGenData = {
      ...paid,
      paymentStatus: 'unpaid',
      paymentDate: undefined,
      prepaidAmount: 30,
    };
    expect(computeCadre(advance).code).toBe('S4');
    const xml = generateUblXml(advance);
    const { monetary } = monetaryOf(xml);
    expect(textOf(monetary['cbc:PrepaidAmount'])).toBe('30.00');
    expect(textOf(monetary['cbc:PayableAmount'])).toBe('90.00');
  });
});

// ─── Remises & charges (AllowanceCharge) — ligne + document ──────────────────

describe('AllowanceCharge — calcul des totaux (EN16931)', () => {
  // Cas de référence du cadrage :
  // Ligne 1 : 10 × 5,00 = 50,00, remise ligne 5,00 → BT-131 = 45,00
  // Ligne 2 : 1 × 100,00 = 100,00 → BT-131 = 100,00
  // Remise document 10,00 (S 20 %) + Charge document 15,00 (S 20 %)
  const refInvoice: InvoiceGenData = {
    ...baseInvoice,
    lines: [
      {
        description: 'Article remisé',
        quantity: 10,
        unitPrice: 5,
        taxRate: 20,
        accountingCode: '606400',
        allowanceCharges: [
          { isCharge: false, amount: 5, reasonCode: '95', reason: 'Remise volume' },
        ],
      },
      {
        description: 'Prestation',
        quantity: 1,
        unitPrice: 100,
        taxRate: 20,
        accountingCode: '622600',
      },
    ],
    documentAllowanceCharges: [
      {
        isCharge: false,
        amount: 10,
        vatCategory: 'S',
        vatRate: 20,
        reason: 'Remise commerciale',
        reasonCode: '95',
      },
      {
        isCharge: true,
        amount: 15,
        vatCategory: 'S',
        vatRate: 20,
        reason: 'Frais de transport',
        reasonCode: 'FC',
      },
    ],
  };

  it('BT-131 net de ligne = gross − remises + charges', () => {
    const c = computeAmounts(refInvoice.lines, refInvoice.documentAllowanceCharges, 0);
    expect(c.computedLines[0].amountExclTax).toBe(45);
    expect(c.computedLines[1].amountExclTax).toBe(100);
  });

  it('BT-106/107/108/109 corrects', () => {
    const c = computeAmounts(refInvoice.lines, refInvoice.documentAllowanceCharges, 0);
    expect(c.lineExtensionTotal).toBe(145); // BT-106
    expect(c.allowanceTotal).toBe(10); // BT-107
    expect(c.chargeTotal).toBe(15); // BT-108
    expect(c.taxExclusiveAmount).toBe(150); // BT-109
  });

  it('base TVA catégorie S = 150, BT-117 = 30, BT-110 = 30', () => {
    const c = computeAmounts(refInvoice.lines, refInvoice.documentAllowanceCharges, 0);
    const s = c.taxCategories.find((g) => g.cat === 'S' && g.rate === 20);
    expect(s?.taxable).toBe(150); // BT-116
    expect(s?.tax).toBe(30); // BT-117
    expect(c.totalTax).toBe(30); // BT-110
  });

  it('BT-112 = 180, BT-115 = 180', () => {
    const c = computeAmounts(refInvoice.lines, refInvoice.documentAllowanceCharges, 0);
    expect(c.taxInclusiveAmount).toBe(180); // BT-112
    expect(c.payableAmount).toBe(180); // BT-115
  });

  it('TVA calculée par catégorie (base×taux), pas par ligne arrondie', () => {
    // 2 lignes à 0,015 € de base théorique : round par ligne → 0,00+0,00 ; par catégorie → round2(0,03×0,2)
    const lines: InvoiceGenLine[] = [
      { description: 'A', quantity: 1, unitPrice: 0.07, taxRate: 20, accountingCode: '606400' },
      { description: 'B', quantity: 1, unitPrice: 0.08, taxRate: 20, accountingCode: '606400' },
    ];
    const c = computeAmounts(lines);
    // base S = 0,15 → TVA = round2(0,15×0,2) = 0,03
    const s = c.taxCategories.find((g) => g.cat === 'S');
    expect(s?.taxable).toBe(0.15);
    expect(s?.tax).toBe(0.03);
  });
});

describe('AllowanceCharge — émission XML', () => {
  const refInvoice: InvoiceGenData = {
    ...baseInvoice,
    lines: [
      {
        description: 'Article remisé',
        quantity: 10,
        unitPrice: 5,
        taxRate: 20,
        accountingCode: '606400',
        allowanceCharges: [
          { isCharge: false, amount: 5, reasonCode: '95', reason: 'Remise volume' },
        ],
      },
      {
        description: 'Prestation',
        quantity: 1,
        unitPrice: 100,
        taxRate: 20,
        accountingCode: '622600',
      },
    ],
    documentAllowanceCharges: [
      {
        isCharge: false,
        amount: 10,
        vatCategory: 'S',
        vatRate: 20,
        reason: 'Remise commerciale',
        reasonCode: '95',
      },
      {
        isCharge: true,
        amount: 15,
        vatCategory: 'S',
        vatRate: 20,
        reason: 'Frais de transport',
        reasonCode: 'FC',
      },
    ],
  };

  it('émet un cac:AllowanceCharge de ligne SANS cac:TaxCategory', () => {
    const xml = generateUblXml(refInvoice);
    const start = xml.indexOf('<cac:InvoiceLine>');
    const end = xml.indexOf('</cac:InvoiceLine>');
    const lineXml = xml.substring(start, end);
    expect(lineXml).toContain('<cac:AllowanceCharge>');
    expect(lineXml).toContain('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>');
    expect(lineXml).toContain('<cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>');
    expect(lineXml).toContain('<cbc:Amount currencyID="EUR">5.00</cbc:Amount>');
    expect(lineXml).not.toContain('<cac:TaxCategory>'); // héritée de la ligne
  });

  it('LineExtensionAmount de ligne reflète le net (BT-131 = 45.00)', () => {
    const xml = generateUblXml(refInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const lines = root['cac:InvoiceLine'] as Record<string, unknown>[];
    expect(textOf(lines[0]['cbc:LineExtensionAmount'])).toBe('45.00');
  });

  it('émet les cac:AllowanceCharge document AVEC cac:TaxCategory, avant cac:TaxTotal', () => {
    const xml = generateUblXml(refInvoice);
    const docAcPos = xml.indexOf('<cbc:AllowanceChargeReason>Remise commerciale');
    const taxTotalPos = xml.indexOf('<cac:TaxTotal>');
    expect(docAcPos).toBeGreaterThan(0);
    expect(docAcPos).toBeLessThan(taxTotalPos);
    // charge document avec sa catégorie TVA
    expect(xml).toContain('<cbc:AllowanceChargeReasonCode>FC</cbc:AllowanceChargeReasonCode>');
  });

  it('document AllowanceCharge porte une cac:TaxCategory (S 20.00)', () => {
    const xml = generateUblXml(refInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const acs = root['cac:AllowanceCharge'] as Record<string, unknown>[];
    expect(acs).toHaveLength(2);
    const cat = acs[0]['cac:TaxCategory'] as Record<string, unknown>;
    expect(String(cat['cbc:ID'])).toBe('S');
    expect(textOf(cat['cbc:Percent'])).toBe('20.00');
  });

  it('LegalMonetaryTotal contient AllowanceTotalAmount=10 et ChargeTotalAmount=15', () => {
    const xml = generateUblXml(refInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const m = root['cac:LegalMonetaryTotal'] as Record<string, unknown>;
    expect(textOf(m['cbc:LineExtensionAmount'])).toBe('145.00');
    expect(textOf(m['cbc:TaxExclusiveAmount'])).toBe('150.00');
    expect(textOf(m['cbc:TaxInclusiveAmount'])).toBe('180.00');
    expect(textOf(m['cbc:AllowanceTotalAmount'])).toBe('10.00');
    expect(textOf(m['cbc:ChargeTotalAmount'])).toBe('15.00');
    expect(textOf(m['cbc:PayableAmount'])).toBe('180.00');
  });

  it('TaxSubtotal : TaxableAmount=150 et TaxAmount=30', () => {
    const xml = generateUblXml(refInvoice);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const taxTotal = root['cac:TaxTotal'] as Record<string, unknown>;
    expect(textOf(taxTotal['cbc:TaxAmount'])).toBe('30.00');
    const subs = taxTotal['cac:TaxSubtotal'] as Record<string, unknown>[];
    const s = subs.find((x) => {
      const c = x['cac:TaxCategory'] as Record<string, unknown>;
      return String(c['cbc:ID']) === 'S';
    });
    expect(textOf(s?.['cbc:TaxableAmount'])).toBe('150.00');
    expect(textOf(s?.['cbc:TaxAmount'])).toBe('30.00');
  });

  it('reste parseable par parseUbl (allowanceTotal/chargeTotal extraits)', async () => {
    const { parseUbl } = await import('../../apps/worker/src/parsers/ubl.parser');
    const xml = generateUblXml(refInvoice);
    const parsed = parseUbl(xml);
    expect(parsed.allowanceTotal).toBe('10.00');
    expect(parsed.chargeTotal).toBe('15.00');
  });

  it('CreditNote : remise de ligne dans CreditNoteLine', () => {
    const xml = generateUblXml({ ...refInvoice, direction: 'CREDIT_NOTE' });
    const start = xml.indexOf('<cac:CreditNoteLine>');
    const end = xml.indexOf('</cac:CreditNoteLine>');
    const lineXml = xml.substring(start, end);
    expect(lineXml).toContain('<cac:AllowanceCharge>');
    expect(lineXml).toContain('<cbc:Amount currencyID="EUR">5.00</cbc:Amount>');
  });
});

describe('validateAllowanceCharges', () => {
  it('accepte une remise/charge valide', () => {
    expect(() =>
      validateAllowanceCharges({
        ...baseInvoice,
        documentAllowanceCharges: [
          { isCharge: false, amount: 10, vatCategory: 'S', vatRate: 20, reasonCode: '95' },
        ],
      }),
    ).not.toThrow();
  });

  it('rejette un montant absent ou nul', () => {
    expect(() =>
      validateAllowanceCharges({
        ...baseInvoice,
        lines: [
          { ...baseLine, allowanceCharges: [{ isCharge: false, amount: 0, reasonCode: '95' }] },
        ],
      }),
    ).toThrow(InvoiceValidationError);
  });

  it('rejette une remise sans motif ni code motif (BR-33/BR-42)', () => {
    expect(() =>
      validateAllowanceCharges({
        ...baseInvoice,
        lines: [{ ...baseLine, allowanceCharges: [{ isCharge: false, amount: 5 }] }],
      }),
    ).toThrow(InvoiceValidationError);
  });

  it('rejette une remise/charge document sans catégorie TVA (BR-32/BR-43)', () => {
    expect(() =>
      validateAllowanceCharges({
        ...baseInvoice,
        documentAllowanceCharges: [{ isCharge: true, amount: 15, reasonCode: 'FC' }],
      }),
    ).toThrow(InvoiceValidationError);
  });

  it('generateUblXml lève si remise/charge invalide', () => {
    expect(() =>
      generateUblXml({
        ...baseInvoice,
        documentAllowanceCharges: [{ isCharge: false, amount: 10, vatCategory: 'S', vatRate: 20 }],
      }),
    ).toThrow(InvoiceValidationError);
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

// ─── Types 389 (autofacturation) & 393 (affacturage) ─────────────────────────

const svcLine: InvoiceGenLine = {
  description: 'Prestation',
  quantity: 1,
  unitPrice: 100,
  taxRate: 20,
  accountingCode: '622600',
};

describe('SELF_BILLED — autofacturation (389)', () => {
  const selfBilled: InvoiceGenData = {
    ...baseInvoice,
    lines: [svcLine],
    direction: 'SELF_BILLED',
  };

  it('émet InvoiceTypeCode 389 dans un document Invoice (pas un CreditNote)', () => {
    const xml = generateUblXml(selfBilled);
    expect(xml).toContain('<cbc:InvoiceTypeCode>389</cbc:InvoiceTypeCode>');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain('<cac:InvoiceLine>');
    expect(xml).not.toContain('<CreditNote ');
  });

  it('ajoute automatiquement une mention « Autofacturation »', () => {
    const xml = generateUblXml(selfBilled);
    expect(xml).toContain('<cbc:Note>Autofacturation</cbc:Note>');
  });

  it('ne duplique pas la mention si déjà présente', () => {
    const notes = resolveNotes({
      ...selfBilled,
      notes: [{ text: 'Autofacturation (mandat 2026)' }],
    });
    expect(notes.filter((n) => /autofacturation/i.test(n.text))).toHaveLength(1);
  });

  it('calcule le cadre comme un 380 (S1 par défaut, S4 si acompte)', () => {
    expect(computeCadre(selfBilled).code).toBe('S1');
    expect(computeCadre({ ...selfBilled, prepaidAmount: 50 }).code).toBe('S4');
    expect(computeCadre({ ...selfBilled, paymentStatus: 'paid' }).code).toBe('S2');
  });

  it('directionLabel renvoie « Autofacturation (389) »', () => {
    expect(directionLabel('SELF_BILLED')).toBe('Autofacturation (389)');
  });
});

describe('FACTORING — affacturage (393)', () => {
  const factoring: InvoiceGenData = {
    ...baseInvoice,
    lines: [svcLine],
    direction: 'FACTORING',
    payee: { name: 'CréditFactor SA', identifier: 'CESSION-001', legalId: '38291746500031' },
  };

  it('émet InvoiceTypeCode 393 dans un document Invoice', () => {
    const xml = generateUblXml(factoring);
    expect(xml).toContain('<cbc:InvoiceTypeCode>393</cbc:InvoiceTypeCode>');
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
  });

  it('émet cac:PayeeParty avec BT-59/60/61', () => {
    const xml = generateUblXml(factoring);
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    const payee = root['cac:PayeeParty'] as Record<string, unknown>;
    expect(payee).toBeTruthy();
    const name = (payee['cac:PartyName'] as Record<string, unknown>)['cbc:Name'];
    expect(String(name)).toBe('CréditFactor SA');
    const ident = (payee['cac:PartyIdentification'] as Record<string, unknown>)['cbc:ID'];
    expect(String(ident)).toBe('CESSION-001');
    const legal = (payee['cac:PartyLegalEntity'] as Record<string, unknown>)['cbc:CompanyID'];
    expect(String(legal)).toBe('38291746500031');
  });

  it('positionne PayeeParty après AccountingCustomerParty et avant TaxTotal', () => {
    const xml = generateUblXml(factoring);
    const posCustomer = xml.indexOf('</cac:AccountingCustomerParty>');
    const posPayee = xml.indexOf('<cac:PayeeParty>');
    const posTax = xml.indexOf('<cac:TaxTotal>');
    expect(posCustomer).toBeLessThan(posPayee);
    expect(posPayee).toBeLessThan(posTax);
  });

  it('ajoute automatiquement une mention de subrogation (code ABL)', () => {
    const xml = generateUblXml(factoring);
    expect(xml).toContain('<cbc:Note>ABL#Facture cédée');
    expect(xml).toContain('subrogation');
  });

  it('validation : rejette un 393 sans payee.name', () => {
    expect(() => validatePayee({ ...factoring, payee: undefined })).toThrow(InvoiceValidationError);
    expect(() => generateUblXml({ ...factoring, payee: undefined })).toThrow(
      InvoiceValidationError,
    );
  });

  it('validation : accepte un 393 avec payee.name', () => {
    expect(() => validatePayee(factoring)).not.toThrow();
  });

  it('n’émet pas PayeeParty pour une facture 380 sans payee', () => {
    const xml = generateUblXml({ ...baseInvoice, lines: [svcLine] });
    expect(xml).not.toContain('<cac:PayeeParty>');
  });
});

// ─── Mentions structurées BT-21 (BG-1) ───────────────────────────────────────

describe('Notes structurées BT-21', () => {
  it('isConfirmedNoteSubjectCode : REG/AAB/ABL confirmés, BLU/INV non', () => {
    expect(isConfirmedNoteSubjectCode('REG')).toBe(true);
    expect(isConfirmedNoteSubjectCode('AAB')).toBe(true);
    expect(isConfirmedNoteSubjectCode('ABL')).toBe(true);
    expect(isConfirmedNoteSubjectCode('BLU')).toBe(false);
    expect(isConfirmedNoteSubjectCode('INV')).toBe(false);
    expect(isConfirmedNoteSubjectCode(undefined)).toBe(false);
  });

  it('émet les codes confirmés avec préfixe « CODE# » et BLU en texte seul', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      lines: [svcLine],
      notes: [
        { subjectCode: 'REG', text: 'Régime particulier' },
        { subjectCode: 'AAB', text: 'Escompte 2 %' },
        { subjectCode: 'BLU', text: 'Éco-participation' },
      ],
    });
    expect(xml).toContain('<cbc:Note>REG#Régime particulier</cbc:Note>');
    expect(xml).toContain('<cbc:Note>AAB#Escompte 2 %</cbc:Note>');
    // BLU non confirmé → texte seul, sans préfixe
    expect(xml).toContain('<cbc:Note>Éco-participation</cbc:Note>');
    expect(xml).not.toContain('BLU#');
  });

  it('émet les 3 notes au niveau document', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      lines: [svcLine],
      notes: [
        { subjectCode: 'REG', text: 'A' },
        { subjectCode: 'AAB', text: 'B' },
        { subjectCode: 'BLU', text: 'C' },
      ],
    });
    const doc = xmlParser.parse(xml) as Record<string, unknown>;
    const root = doc['Invoice'] as Record<string, unknown>;
    expect(root['cbc:Note']).toHaveLength(3);
  });

  it('conversion ascendante : note (string) → 1 entrée', () => {
    const notes = resolveNotes({ ...baseInvoice, lines: [svcLine], note: 'Ancienne note libre' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ text: 'Ancienne note libre' });
  });

  it('notes (tableau) a la priorité sur note (string)', () => {
    const notes = resolveNotes({
      ...baseInvoice,
      lines: [svcLine],
      note: 'libre',
      notes: [{ text: 'structurée' }],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('structurée');
  });

  it('reste parseable par parseUbl avec des notes', async () => {
    const { parseUbl } = await import('../../apps/worker/src/parsers/ubl.parser');
    const xml = generateUblXml({
      ...baseInvoice,
      lines: [svcLine],
      notes: [{ subjectCode: 'REG', text: 'Régime particulier' }],
    });
    expect(() => parseUbl(xml)).not.toThrow();
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ─── generateUblXml — EndpointID (BT-34/BT-49) EAS Peppol ─────────────────────
// Vendeurs étrangers / OSS « EU » : jamais de scheme faux, jamais d'EndpointID sans
// schemeID. Hypothèse 0225 (FRCTC) pour les non mappables avec routingCode.
describe('generateUblXml — EndpointID EAS (BT-34/BT-49)', () => {
  // Extrait le 1er cbc:EndpointID d'une portion de XML (ou null si absent).
  const endpointIn = (section: string): { scheme: string; value: string } | null => {
    const m = section.match(/<cbc:EndpointID schemeID="([^"]+)">([^<]*)<\/cbc:EndpointID>/);
    return m ? { scheme: m[1], value: m[2] } : null;
  };
  // Sépare le XML entre partie vendeur (avant AccountingCustomerParty) et acheteur (après).
  const endpoints = (xml: string) => {
    const idx = xml.indexOf('<cac:AccountingCustomerParty');
    return {
      supplier: endpointIn(xml.slice(0, idx)),
      buyer: endpointIn(xml.slice(idx)),
    };
  };

  it('vendeur FR avec SIRET → scheme 0009 (SIRET)', () => {
    const xml = generateUblXml(baseInvoice); // supplier.siret renseigné
    expect(endpoints(xml).supplier).toEqual({
      scheme: '0009',
      value: baseInvoice.supplier.siret,
    });
  });

  it('vendeur DE (TVA DE…, sans SIRET) → scheme 9930 (Allemagne)', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      supplier: { name: 'Muster GmbH', taxId: 'DE123456789' }, // pas de SIRET
    });
    expect(endpoints(xml).supplier).toEqual({ scheme: '9930', value: 'DE123456789' });
  });

  it('vendeur IT (Partita IVA) → scheme 0211 (Italie)', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      supplier: { name: 'Esempio SRL', taxId: 'IT12345678901' },
    });
    expect(endpoints(xml).supplier).toEqual({ scheme: '0211', value: 'IT12345678901' });
  });

  it('vendeur OSS « EU » AVEC routingCode → scheme 0225 + valeur = routingCode (pas la TVA, pas 9957)', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      supplier: { name: 'OpenAI', taxId: 'EU372041333', routingCode: 'FR-CTC-OPENAI-001' },
    });
    const ep = endpoints(xml).supplier;
    expect(ep).toEqual({ scheme: '0225', value: 'FR-CTC-OPENAI-001' });
    expect(ep?.scheme).not.toBe('9957');
    expect(ep?.value).not.toBe('EU372041333');
  });

  it('vendeur OSS « EU » SANS routingCode → aucun cbc:EndpointID émis + peppolRoutable=false', () => {
    const data: InvoiceGenData = {
      ...baseInvoice,
      supplier: { name: 'OpenAI', taxId: 'EU372041333' }, // ni SIRET ni routingCode
      buyerSiret: '40483304800022', // acheteur routable pour isoler le vendeur
    };
    const xml = generateUblXml(data);
    expect(endpoints(xml).supplier).toBeNull();
    // jamais de scheme faux 9957 pour un identifiant non-FR
    expect(xml).not.toContain('schemeID="9957">EU372041333');
    expect(computePeppolRoutable(data)).toBe(false);
  });

  it('acheteur FR (TVA FR…, sans SIRET) → scheme 9957 (légitime, identifiant français)', () => {
    const xml = generateUblXml({
      ...baseInvoice,
      buyerSiret: undefined,
      buyerVatNumber: 'FR12404833048',
    });
    expect(endpoints(xml).buyer).toEqual({ scheme: '9957', value: 'FR12404833048' });
  });

  it('computePeppolRoutable=true quand vendeur ET acheteur ont un EndpointID', () => {
    expect(computePeppolRoutable({ ...baseInvoice, buyerSiret: '40483304800022' })).toBe(true);
  });
});
