import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceGenLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number; // pourcentage, ex : 20 pour 20 %
}

export interface InvoiceGenSupplier {
  name: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  taxId?: string;  // N° TVA intracommunautaire ou SIREN
  siret?: string;
}

export interface InvoiceGenData {
  invoiceNumber: string;
  invoiceDate: string;   // YYYY-MM-DD
  dueDate?: string;
  currency: string;      // ISO 4217, ex : EUR
  direction: 'INVOICE' | 'CREDIT_NOTE';
  supplier: InvoiceGenSupplier;
  buyerName?: string;
  lines: InvoiceGenLine[];
  note?: string;
}

export interface ComputedLine extends InvoiceGenLine {
  lineNo: number;
  amountExclTax: number;
  taxAmount: number;
  amountInclTax: number;
}

export interface ComputedAmounts {
  computedLines: ComputedLine[];
  totalExclTax: number;
  totalTax: number;
  totalInclTax: number;
}

export interface GeneratedInvoice {
  xmlContent: string;
  xmlFilename: string;
  pdfFilename: string;
  summary: {
    invoiceNumber: string;
    direction: string;
    supplierName: string;
    supplierIdentifier: string;
    totalExclTax: number;
    totalTax: number;
    totalInclTax: number;
    currency: string;
    lineCount: number;
  };
}

export interface SupplierEnrichment {
  name: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  taxId?: string;
  siret?: string;
  source: 'PAPPERS' | 'INSEE';
}

// ─── Utilitaires internes ─────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function getGeneratedDir(): string {
  const base = process.env.FILE_STORAGE_PATH
    ? path.join(process.env.FILE_STORAGE_PATH, 'generated')
    : path.join(process.cwd(), 'data', 'generated');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function buildFilename(invoiceNumber: string, ext: string): string {
  const safe = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 60);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return `GEN_${safe}_${ts}.${ext}`;
}

// ─── Calcul des montants ──────────────────────────────────────────────────────

export function computeAmounts(lines: InvoiceGenLine[]): ComputedAmounts {
  let totalExclTax = 0;
  let totalTax = 0;

  const computedLines: ComputedLine[] = lines.map((line, idx) => {
    const amountExclTax = round2(line.quantity * line.unitPrice);
    const taxAmount = round2(amountExclTax * line.taxRate / 100);
    const amountInclTax = round2(amountExclTax + taxAmount);
    totalExclTax += amountExclTax;
    totalTax += taxAmount;
    return { ...line, lineNo: idx + 1, amountExclTax, taxAmount, amountInclTax };
  });

  return {
    computedLines,
    totalExclTax: round2(totalExclTax),
    totalTax: round2(totalTax),
    totalInclTax: round2(totalExclTax + totalTax),
  };
}

// ─── Génération XML UBL 2.1 ──────────────────────────────────────────────────

export function generateUblXml(data: InvoiceGenData): string {
  const { computedLines, totalExclTax, totalTax, totalInclTax } = computeAmounts(data.lines);

  const isCreditNote = data.direction === 'CREDIT_NOTE';
  const rootTag      = isCreditNote ? 'CreditNote' : 'Invoice';
  const lineTag      = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag       = isCreditNote ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const typeCodeTag  = isCreditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode';
  const typeCode     = isCreditNote ? '381' : '380';
  const xmlns        = isCreditNote
    ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
    : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';

  const fmt = (n: number) => n.toFixed(2);

  // Regroupement TVA par taux pour TaxTotal/TaxSubtotal
  const taxGroups = new Map<number, { taxable: number; tax: number }>();
  for (const line of computedLines) {
    const g = taxGroups.get(line.taxRate) ?? { taxable: 0, tax: 0 };
    taxGroups.set(line.taxRate, {
      taxable: round2(g.taxable + line.amountExclTax),
      tax:     round2(g.tax + line.taxAmount),
    });
  }

  const taxSubtotals = Array.from(taxGroups.entries())
    .map(([rate, g]) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${data.currency}">${fmt(g.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${data.currency}">${fmt(g.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${rate === 0 ? 'Z' : 'S'}</cbc:ID>
        <cbc:Percent>${rate.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`)
    .join('');

  const invoiceLines = computedLines
    .map(line => `
  <cac:${lineTag}>
    <cbc:ID>${line.lineNo}</cbc:ID>
    <${qtyTag} unitCode="C62">${line.quantity}</${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(line.amountExclTax)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>${escapeXml(line.description)}</cbc:Description>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${data.currency}">${fmt(line.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${data.currency}">${fmt(line.taxAmount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${data.currency}">${fmt(line.amountExclTax)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${data.currency}">${fmt(line.taxAmount)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${line.taxRate === 0 ? 'Z' : 'S'}</cbc:ID>
          <cbc:Percent>${line.taxRate.toFixed(2)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
  </cac:${lineTag}>`)
    .join('');

  const supplierAddress = (data.supplier.address || data.supplier.city)
    ? `
      <cac:PostalAddress>${
    data.supplier.address ? `
        <cbc:StreetName>${escapeXml(data.supplier.address)}</cbc:StreetName>` : ''}${
    data.supplier.city ? `
        <cbc:CityName>${escapeXml(data.supplier.city)}</cbc:CityName>` : ''}${
    data.supplier.postalCode ? `
        <cbc:PostalZone>${escapeXml(data.supplier.postalCode)}</cbc:PostalZone>` : ''}
        <cac:Country>
          <cbc:IdentificationCode>${data.supplier.country ?? 'FR'}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>`
    : '';

  const supplierTaxScheme = data.supplier.taxId
    ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.supplier.taxId)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : '';

  const supplierSiret = data.supplier.siret
    ? `
        <cbc:CompanyID>${escapeXml(data.supplier.siret)}</cbc:CompanyID>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootTag} xmlns="${xmlns}"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${data.invoiceDate}</cbc:IssueDate>${
  data.dueDate ? `
  <cbc:DueDate>${data.dueDate}</cbc:DueDate>` : ''}
  <${typeCodeTag}>${typeCode}</${typeCodeTag}>
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>TEST-GENERATOR-2026</cbc:BuyerReference>${
  data.note ? `
  <cbc:Note>${escapeXml(data.note)}</cbc:Note>` : ''}

  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escapeXml(data.supplier.name)}</cbc:Name>
      </cac:PartyName>${supplierAddress}${supplierTaxScheme}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(data.supplier.name)}</cbc:RegistrationName>${supplierSiret}
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName>
        <cbc:Name>${escapeXml(data.buyerName ?? 'DEMO INDUSTRIE SAS')}</cbc:Name>
      </cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>

  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${fmt(totalTax)}</cbc:TaxAmount>${taxSubtotals}
  </cac:TaxTotal>

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(totalExclTax)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${data.currency}">${fmt(totalExclTax)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${data.currency}">${fmt(totalInclTax)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${fmt(totalInclTax)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${invoiceLines}
</${rootTag}>`;
}

// ─── Génération PDF ───────────────────────────────────────────────────────────

function writePdf(data: InvoiceGenData, computed: ComputedAmounts, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const fmt = (n: number) => n.toFixed(2) + ' ' + data.currency;
    const title = data.direction === 'CREDIT_NOTE' ? 'AVOIR DE TEST' : 'FACTURE DE TEST';

    // Titre
    doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text('Document généré par BILLING Invoice Generator — usage test uniquement', { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(0.8);

    // En-tête facture
    doc.fontSize(10).font('Helvetica-Bold').text('Informations facture', { underline: true });
    doc.fontSize(10).font('Helvetica');
    doc.text(`Numéro          : ${data.invoiceNumber}`);
    doc.text(`Date d'émission : ${data.invoiceDate}`);
    if (data.dueDate) doc.text(`Date d'échéance : ${data.dueDate}`);
    doc.text(`Devise          : ${data.currency}`);
    doc.moveDown(0.8);

    // Fournisseur
    doc.fontSize(10).font('Helvetica-Bold').text('Fournisseur', { underline: true });
    doc.fontSize(10).font('Helvetica');
    doc.text(data.supplier.name);
    if (data.supplier.address) doc.text(data.supplier.address);
    const cityLine = [data.supplier.postalCode, data.supplier.city].filter(Boolean).join(' ');
    if (cityLine) doc.text(cityLine);
    if (data.supplier.taxId) doc.text(`N° TVA : ${data.supplier.taxId}`);
    if (data.supplier.siret) doc.text(`SIRET  : ${data.supplier.siret}`);
    doc.moveDown(0.8);

    // Client
    doc.fontSize(10).font('Helvetica-Bold').text('Client', { underline: true });
    doc.fontSize(10).font('Helvetica').text(data.buyerName ?? 'DEMO INDUSTRIE SAS');
    doc.moveDown(0.8);

    // Lignes
    doc.fontSize(10).font('Helvetica-Bold').text('Lignes de facture', { underline: true });
    doc.moveDown(0.3);

    // En-tête tableau (monospace via positionnement manuel)
    const COL = { desc: 50, qty: 260, pu: 310, ht: 365, tva: 415, ttc: 460 };
    const tableTop = doc.y;

    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('Description',  COL.desc, tableTop, { width: 200 });
    doc.text('Qté',          COL.qty,  tableTop, { width: 45, align: 'right' });
    doc.text('P.U. HT',      COL.pu,   tableTop, { width: 50, align: 'right' });
    doc.text('Montant HT',   COL.ht,   tableTop, { width: 45, align: 'right' });
    doc.text('TVA',          COL.tva,  tableTop, { width: 40, align: 'right' });
    doc.text('TTC',          COL.ttc,  tableTop, { width: 50, align: 'right' });

    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(515, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.2);

    doc.fontSize(8).font('Helvetica');
    for (const line of computed.computedLines) {
      const rowY = doc.y;
      doc.text(line.description.substring(0, 45), COL.desc, rowY, { width: 200 });
      doc.text(String(line.quantity),              COL.qty,  rowY, { width: 45, align: 'right' });
      doc.text(line.unitPrice.toFixed(2),          COL.pu,   rowY, { width: 50, align: 'right' });
      doc.text(line.amountExclTax.toFixed(2),      COL.ht,   rowY, { width: 45, align: 'right' });
      doc.text(`${line.taxRate}%`,                 COL.tva,  rowY, { width: 40, align: 'right' });
      doc.text(line.amountInclTax.toFixed(2),      COL.ttc,  rowY, { width: 50, align: 'right' });
      doc.moveDown(0.3);
    }

    doc.moveTo(50, doc.y).lineTo(515, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(0.5);

    // Totaux
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total HT   : ${fmt(computed.totalExclTax)}`, { align: 'right' });
    doc.text(`TVA totale : ${fmt(computed.totalTax)}`,     { align: 'right' });
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text(`Total TTC  : ${fmt(computed.totalInclTax)}`, { align: 'right' });

    if (data.note) {
      doc.moveDown();
      doc.fontSize(9).font('Helvetica').fillColor('#555555')
        .text(`Note : ${data.note}`);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ─── Entrée principale ────────────────────────────────────────────────────────

export async function generateAndSave(data: InvoiceGenData): Promise<GeneratedInvoice> {
  const xmlContent  = generateUblXml(data);
  const computed    = computeAmounts(data.lines);
  const dir         = getGeneratedDir();
  const xmlFilename = buildFilename(data.invoiceNumber, 'xml');
  const pdfFilename = buildFilename(data.invoiceNumber, 'pdf');

  fs.writeFileSync(path.join(dir, xmlFilename), xmlContent, 'utf-8');
  await writePdf(data, computed, path.join(dir, pdfFilename));

  return {
    xmlContent,
    xmlFilename,
    pdfFilename,
    summary: {
      invoiceNumber:      data.invoiceNumber,
      direction:          data.direction,
      supplierName:       data.supplier.name,
      supplierIdentifier: data.supplier.taxId ?? data.supplier.siret ?? 'UNKNOWN',
      totalExclTax:       computed.totalExclTax,
      totalTax:           computed.totalTax,
      totalInclTax:       computed.totalInclTax,
      currency:           data.currency,
      lineCount:          data.lines.length,
    },
  };
}

export function getGeneratedFilePath(filename: string): string {
  const dir  = getGeneratedDir();
  const safe = path.basename(filename); // anti path-traversal
  return path.join(dir, safe);
}

// ─── Enrichissement fournisseur ───────────────────────────────────────────────

export async function enrichFromPappers(siren: string): Promise<SupplierEnrichment | null> {
  const apiKey = process.env.PAPPERS_API ?? process.env.PAPPERS_API_KEY;
  const baseUrl = (process.env.PAPPERS_URL ?? 'https://api.pappers.fr/v2/').replace(/\/$/, '');
  if (!apiKey) return null;

  const url = `${baseUrl}/entreprise?api_token=${encodeURIComponent(apiKey)}&siren=${encodeURIComponent(siren)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const body = await res.json() as Record<string, unknown>;
  const siege = body.siege as Record<string, unknown> | undefined;

  const name = String(body.nom_entreprise ?? body.denomination ?? '').trim();
  if (!name) return null;

  return {
    name,
    address:    siege ? String(siege.adresse_ligne_1 ?? siege.voie ?? '').trim() || undefined : undefined,
    city:       siege ? String(siege.ville ?? '').trim() || undefined : undefined,
    postalCode: siege ? String(siege.code_postal ?? '').trim() || undefined : undefined,
    country:    'FR',
    taxId:      body.numero_tva_intracommunautaire
      ? String(body.numero_tva_intracommunautaire).trim()
      : undefined,
    siret: siege ? String(siege.siret ?? '').trim() || undefined : undefined,
    source: 'PAPPERS',
  };
}

export async function enrichFromInsee(siren: string): Promise<SupplierEnrichment | null> {
  const consumerKey    = process.env.INSEE_CONSUMER_KEY ?? process.env.INSEE_API_KEY;
  const consumerSecret = process.env.INSEE_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) return null;

  // Obtenir un token OAuth2
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const tokenRes = await fetch('https://api.insee.fr/token', {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body:   'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenRes.ok) return null;

  const { access_token } = await tokenRes.json() as { access_token: string };

  // Appel Sirene API
  const sirenRes = await fetch(
    `https://api.insee.fr/api-sirene/3.11/siren/${encodeURIComponent(siren)}`,
    {
      headers: { Authorization: `Bearer ${access_token}` },
      signal:  AbortSignal.timeout(10_000),
    },
  );
  if (!sirenRes.ok) return null;

  const data = await sirenRes.json() as Record<string, unknown>;
  const unite = data.uniteLegale as Record<string, unknown> | undefined;
  const periodes = unite?.periodesUniteLegale as Record<string, unknown>[] | undefined;
  const last = periodes?.[0] ?? {};

  const nom = String(
    last.denominationUniteLegale ??
    `${last.prenomUsuelUniteLegale ?? ''} ${last.nomUniteLegale ?? ''}`.trim()
  ).trim();

  return {
    name:    nom || siren,
    country: 'FR',
    source:  'INSEE',
  };
}

export async function enrichSupplier(siren: string): Promise<SupplierEnrichment | null> {
  try {
    const pappers = await enrichFromPappers(siren);
    if (pappers?.name) return pappers;
  } catch {
    // Pappers indisponible, on essaie INSEE
  }
  try {
    return await enrichFromInsee(siren);
  } catch {
    return null;
  }
}
