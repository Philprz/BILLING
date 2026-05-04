/**
 * Parsing UBL 2.1 / CII D16B côté API.
 * Utilisé par la route d'upload manuel et l'endpoint re-parse-lines.
 */

import { XMLParser } from 'fast-xml-parser';

export interface ParsedLine {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  amountExclTax: string;
  taxRate: string | null;
  taxCode: string | null;
  taxAmount: string;
  amountInclTax: string;
}

export interface SupplierExtracted {
  endpointId?: string | null;
  partyIdentificationIds?: string[];
  taxCompanyIds?: string[];
  legalCompanyId?: string | null;
  siren: string | null;
  siret: string | null;
  vatNumber: string | null;
  fullAddress?: string | null;
  street: string | null;
  street2: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
}

export interface ParsedInvoiceHeader {
  format: 'UBL' | 'CII' | 'PDF_ONLY';
  direction: 'INVOICE' | 'CREDIT_NOTE';
  docNumberPa: string;
  docDate: string;
  dueDate: string | null;
  currency: string;
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  totalExclTax: string;
  totalTax: string;
  totalInclTax: string;
  lines: ParsedLine[];
  supplierExtracted: SupplierExtracted | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function text(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>))
    return String((node as Record<string, unknown>)['#text']).trim();
  return '';
}

function num(node: unknown): string {
  const s = text(node);
  return s !== '' ? s : '0';
}

function asArray<T>(node: T | T[] | undefined): T[] {
  if (Array.isArray(node)) return node;
  return node ? [node] : [];
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function findSirenSiret(values: string[]): { siren: string | null; siret: string | null } {
  let siren: string | null = null;
  let siret: string | null = null;
  for (const value of values) {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 14 && !siret) siret = digits;
    else if (digits.length === 9 && !siren) siren = digits;
  }
  if (!siren && siret) siren = siret.slice(0, 9);
  return { siren, siret };
}

function findVatNumber(values: string[]): string | null {
  return (
    values
      .find((value) => /^[A-Z]{2}[A-Z0-9]+$/i.test(value.replace(/\s/g, '')))
      ?.replace(/\s/g, '') ?? null
  );
}

// ─── Extraction données fournisseur UBL ──────────────────────────────────────

function extractUblSupplier(
  supplierParty: Record<string, unknown> | undefined,
  supplierPaIdentifier: string,
): SupplierExtracted {
  const endpointId = text(supplierParty?.['cbc:EndpointID']) || null;
  const legalEntity = supplierParty?.['cac:PartyLegalEntity'] as
    | Record<string, unknown>
    | undefined;
  const legalCompanyId = text(legalEntity?.['cbc:CompanyID']);

  const partyIdentificationIds = uniqueNonEmpty(
    asArray(
      supplierParty?.['cac:PartyIdentification'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((pid) => text(pid['cbc:ID'])),
  );

  const taxCompanyIds = uniqueNonEmpty(
    asArray(
      supplierParty?.['cac:PartyTaxScheme'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((scheme) => text(scheme['cbc:CompanyID'])),
  );

  const identifierCandidates = uniqueNonEmpty([
    supplierPaIdentifier,
    endpointId ?? '',
    legalCompanyId,
    ...partyIdentificationIds,
    ...taxCompanyIds,
  ]);
  const { siren, siret } = findSirenSiret(identifierCandidates);
  const vatNumber = findVatNumber([supplierPaIdentifier, ...taxCompanyIds, endpointId ?? '']);

  // Adresse postale
  const address = supplierParty?.['cac:PostalAddress'] as Record<string, unknown> | undefined;
  const street = text(address?.['cbc:StreetName']) || null;
  const street2 = text(address?.['cbc:AdditionalStreetName']) || null;
  const city = text(address?.['cbc:CityName']) || null;
  const postalCode = text(address?.['cbc:PostalZone']) || null;
  const countryNode = address?.['cac:Country'] as Record<string, unknown> | undefined;
  const country = text(countryNode?.['cbc:IdentificationCode']) || null;
  const fullAddress =
    [street, street2, postalCode, city, country].filter(Boolean).join(', ') || null;

  // Contact
  const contact = supplierParty?.['cac:Contact'] as Record<string, unknown> | undefined;
  const email = text(contact?.['cbc:ElectronicMail']) || null;
  const phone = text(contact?.['cbc:Telephone']) || null;

  return {
    endpointId,
    partyIdentificationIds,
    taxCompanyIds,
    legalCompanyId: legalCompanyId || null,
    siren,
    siret,
    vatNumber,
    fullAddress,
    street,
    street2,
    city,
    postalCode,
    country,
    email,
    phone,
  };
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const NS_UBL_INV = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_UBL_CN = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';
const NS_CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => {
    const local = tagName.includes(':') ? tagName.split(':')[1] : tagName;
    return ['InvoiceLine', 'CreditNoteLine', 'TaxSubtotal', 'AllowanceCharge'].includes(local);
  },
});

function parseUblLines(root: Record<string, unknown>): ParsedLine[] {
  const lineNodes =
    ((root['cac:InvoiceLine'] ?? root['cac:CreditNoteLine']) as
      | Record<string, unknown>[]
      | undefined) ?? [];

  return lineNodes.map((l, idx) => {
    const lineNo = Number(text(l['cbc:ID'])) || idx + 1;
    const description =
      text(
        (l['cac:Item'] as Record<string, unknown>)?.['cbc:Description'] ??
          (l['cac:Item'] as Record<string, unknown>)?.['cbc:Name'] ??
          '',
      ) || `Ligne ${lineNo}`;

    const quantity = num(l['cbc:InvoicedQuantity'] ?? l['cbc:CreditedQuantity']);
    const amountExclTax = num(l['cbc:LineExtensionAmount']);
    const priceNode = l['cac:Price'] as Record<string, unknown> | undefined;
    const unitPrice = num(priceNode?.['cbc:PriceAmount']);

    const lineTaxTotal = l['cac:TaxTotal'] as Record<string, unknown> | undefined;
    const taxSubtotals =
      (lineTaxTotal?.['cac:TaxSubtotal'] as Record<string, unknown>[] | undefined) ?? [];
    const firstSub = taxSubtotals[0] as Record<string, unknown> | undefined;
    const taxCategory = firstSub?.['cac:TaxCategory'] as Record<string, unknown> | undefined;

    // Fallback : ClassifiedTaxCategory dans cac:Item (utilisé par le générateur BILLING — pas de TaxTotal par ligne)
    const itemNode = l['cac:Item'] as Record<string, unknown> | undefined;
    const classifiedCat = itemNode?.['cac:ClassifiedTaxCategory'] as
      | Record<string, unknown>
      | undefined;

    const taxRate =
      text(taxCategory?.['cbc:Percent']) || text(classifiedCat?.['cbc:Percent']) || null;
    const taxCode = text(taxCategory?.['cbc:ID']) || text(classifiedCat?.['cbc:ID']) || null;

    let taxAmount = num(lineTaxTotal?.['cbc:TaxAmount']);
    // Si pas de TaxTotal au niveau ligne mais taux connu, calcul à partir du HT
    if (taxAmount === '0' && taxRate) {
      taxAmount = ((parseFloat(amountExclTax) * parseFloat(taxRate)) / 100).toFixed(4);
    }

    const amountInclTax = (parseFloat(amountExclTax) + parseFloat(taxAmount || '0')).toFixed(4);

    return {
      lineNo,
      description,
      quantity,
      unitPrice,
      amountExclTax,
      taxRate,
      taxCode,
      taxAmount,
      amountInclTax,
    };
  });
}

function ciiDate(raw: string): string {
  const s = raw.replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : raw.trim();
}

export function parseInvoiceXml(content: string, filename: string): ParsedInvoiceHeader {
  const header = content.slice(0, 2048);
  const isUbl = header.includes(NS_UBL_INV) || header.includes(NS_UBL_CN);
  const isCii = header.includes(NS_CII);

  if (!isUbl && !isCii) {
    throw new Error('Format XML non reconnu. Formats supportés : UBL 2.1, CII D16B.');
  }

  const doc = xmlParser.parse(content) as Record<string, unknown>;

  if (isUbl) {
    const root = (doc['Invoice'] ?? doc['CreditNote']) as Record<string, unknown>;
    if (!root) throw new Error('Élément racine Invoice/CreditNote absent');

    const isCn = 'CreditNote' in doc;
    const typeCode = text(root['cbc:InvoiceTypeCode'] ?? root['cbc:CreditNoteTypeCode']);
    const direction: ParsedInvoiceHeader['direction'] =
      isCn || typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';

    const supplierParty = (root['cac:AccountingSupplierParty'] as Record<string, unknown>)?.[
      'cac:Party'
    ] as Record<string, unknown> | undefined;

    const taxSchemes = supplierParty?.['cac:PartyTaxScheme'];
    const firstTax = Array.isArray(taxSchemes) ? taxSchemes[0] : taxSchemes;
    const monetary = (root['cac:LegalMonetaryTotal'] ?? {}) as Record<string, unknown>;
    const taxTotal = (root['cac:TaxTotal'] ?? {}) as Record<string, unknown>;

    const supplierPaIdentifier =
      text(supplierParty?.['cbc:EndpointID']) ||
      text((firstTax as Record<string, unknown>)?.['cbc:CompanyID']) ||
      text(
        (supplierParty?.['cac:PartyLegalEntity'] as Record<string, unknown>)?.['cbc:CompanyID'],
      ) ||
      'UNKNOWN';

    return {
      format: 'UBL',
      direction,
      docNumberPa: text(root['cbc:ID']) || filename,
      docDate: text(root['cbc:IssueDate']) || new Date().toISOString().split('T')[0],
      dueDate: text(root['cbc:DueDate']) || null,
      currency: text(root['cbc:DocumentCurrencyCode']) || 'EUR',
      supplierPaIdentifier,
      supplierNameRaw:
        text((supplierParty?.['cac:PartyName'] as Record<string, unknown>)?.['cbc:Name']) ||
        text(
          (supplierParty?.['cac:PartyLegalEntity'] as Record<string, unknown>)?.[
            'cbc:RegistrationName'
          ],
        ) ||
        filename,
      totalExclTax: num(monetary['cbc:TaxExclusiveAmount']),
      totalTax: num(taxTotal?.['cbc:TaxAmount']),
      totalInclTax: num(monetary['cbc:TaxInclusiveAmount'] ?? monetary['cbc:PayableAmount']),
      lines: parseUblLines(root),
      supplierExtracted: extractUblSupplier(supplierParty, supplierPaIdentifier),
    };
  }

  // CII
  const root = (doc['rsm:CrossIndustryInvoice'] ?? doc['CrossIndustryInvoice']) as Record<
    string,
    unknown
  >;
  if (!root) throw new Error('Élément racine CrossIndustryInvoice absent');

  const hdr2 = (root['rsm:ExchangedDocument'] as Record<string, unknown>) ?? {};
  const typeCode = text(hdr2['ram:TypeCode']);
  const direction: ParsedInvoiceHeader['direction'] =
    typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';
  const dtNode = (hdr2['ram:IssueDateTime'] ?? {}) as Record<string, unknown>;
  const rawDate = text(dtNode['udt:DateTimeString'] ?? dtNode['DateTimeString'] ?? dtNode);
  const trx = (root['rsm:SupplyChainTradeTransaction'] ?? {}) as Record<string, unknown>;
  const agreement = (trx['ram:ApplicableHeaderTradeAgreement'] ?? {}) as Record<string, unknown>;
  const seller = (agreement['ram:SellerTradeParty'] ?? {}) as Record<string, unknown>;
  const settlement = (trx['ram:ApplicableHeaderTradeSettlement'] ?? {}) as Record<string, unknown>;
  const sums = (settlement['ram:SpecifiedTradeSettlementHeaderMonetarySummation'] ?? {}) as Record<
    string,
    unknown
  >;
  const taxRegs = seller['ram:SpecifiedTaxRegistration'];
  const firstTaxReg = Array.isArray(taxRegs) ? taxRegs[0] : taxRegs;

  return {
    format: 'CII',
    direction,
    docNumberPa: text(hdr2['ram:ID']) || filename,
    docDate: rawDate ? ciiDate(rawDate) : new Date().toISOString().split('T')[0],
    dueDate: null,
    currency: text(settlement['ram:InvoiceCurrencyCode']) || 'EUR',
    supplierPaIdentifier: text((firstTaxReg as Record<string, unknown>)?.['ram:ID']) || 'UNKNOWN',
    supplierNameRaw: text(seller['ram:Name']) || filename,
    totalExclTax: num(sums['ram:TaxBasisTotalAmount']),
    totalTax: num(sums['ram:TaxTotalAmount']),
    totalInclTax: num(sums['ram:GrandTotalAmount']),
    lines: [], // CII line parsing non implémenté
    supplierExtracted: null,
  };
}
