/**
 * Parseur UBL 2.1 — Invoice et CreditNote
 *
 * Namespaces attendus :
 *   xmlns     = urn:oasis:names:specification:ubl:schema:xsd:Invoice-2
 *   xmlns:cac = urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2
 *   xmlns:cbc = urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2
 *
 * InvoiceTypeCode : 380 = Invoice, 381/389 = CreditNote
 */

import { XMLParser } from 'fast-xml-parser';
import type { ParsedInvoice, ParsedLine, SupplierExtracted } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extrait la valeur texte d'un nœud qui peut être une chaîne ou un objet avec #text */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text']).trim();
  }
  return '';
}

/** Retourne la valeur numérique en string (compatible Prisma Decimal) ou '0' */
function numStr(node: unknown): string {
  const s = textOf(node);
  return s !== '' ? s : '0';
}

function requireText(node: unknown, field: string): string {
  const v = textOf(node);
  if (!v) throw new Error(`Champ UBL manquant ou vide : ${field}`);
  return v;
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

// fast-xml-parser options
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // tout en string pour précision décimale
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => {
    const local = tagName.includes(':') ? tagName.split(':')[1] : tagName;
    return ['InvoiceLine', 'CreditNoteLine', 'TaxSubtotal', 'AllowanceCharge'].includes(local);
  },
});

// ─── Extraction données fournisseur ──────────────────────────────────────────

function extractSupplier(
  supplierParty: Record<string, unknown> | undefined,
  supplierPaIdentifier: string,
): SupplierExtracted {
  const endpointId = textOf(supplierParty?.['cbc:EndpointID']) || null;
  const legalEntity = supplierParty?.['cac:PartyLegalEntity'] as
    | Record<string, unknown>
    | undefined;
  const legalCompanyId = textOf(legalEntity?.['cbc:CompanyID']);

  const partyIdentificationIds = uniqueNonEmpty(
    asArray(
      supplierParty?.['cac:PartyIdentification'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((pid) => textOf(pid['cbc:ID'])),
  );

  const taxCompanyIds = uniqueNonEmpty(
    asArray(
      supplierParty?.['cac:PartyTaxScheme'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    ).map((scheme) => textOf(scheme['cbc:CompanyID'])),
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

  const address = supplierParty?.['cac:PostalAddress'] as Record<string, unknown> | undefined;
  const street = textOf(address?.['cbc:StreetName']) || null;
  const street2 = textOf(address?.['cbc:AdditionalStreetName']) || null;
  const city = textOf(address?.['cbc:CityName']) || null;
  const postalCode = textOf(address?.['cbc:PostalZone']) || null;
  const countryNode = address?.['cac:Country'] as Record<string, unknown> | undefined;
  const country = textOf(countryNode?.['cbc:IdentificationCode']) || null;
  const fullAddress =
    [street, street2, postalCode, city, country].filter(Boolean).join(', ') || null;

  const contact = supplierParty?.['cac:Contact'] as Record<string, unknown> | undefined;
  const email = textOf(contact?.['cbc:ElectronicMail']) || null;
  const phone = textOf(contact?.['cbc:Telephone']) || null;

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

// ─── Parser principal ─────────────────────────────────────────────────────────

export function parseUbl(xmlContent: string): ParsedInvoice {
  const doc = xmlParser.parse(xmlContent) as Record<string, unknown>;

  // Racine : Invoice ou CreditNote
  const root = (doc['Invoice'] ?? doc['CreditNote']) as Record<string, unknown> | undefined;
  if (!root) {
    throw new Error('Document UBL invalide : élément racine Invoice ou CreditNote absent');
  }

  const isCreditNote = 'CreditNote' in doc;

  // Direction
  const typeCode = textOf(root['cbc:InvoiceTypeCode'] ?? root['cbc:CreditNoteTypeCode']);
  const direction: ParsedInvoice['direction'] =
    isCreditNote || typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';

  // Identifiants
  const docNumberPa = requireText(root['cbc:ID'], 'cbc:ID');
  const docDate = requireText(root['cbc:IssueDate'], 'cbc:IssueDate');
  const dueDate = textOf(root['cbc:DueDate']) || null;
  const currency = requireText(root['cbc:DocumentCurrencyCode'], 'cbc:DocumentCurrencyCode');

  // Fournisseur
  const supplierParty = (root['cac:AccountingSupplierParty'] as Record<string, unknown>)?.[
    'cac:Party'
  ] as Record<string, unknown> | undefined;
  if (!supplierParty) throw new Error('cac:AccountingSupplierParty/cac:Party absent');

  const supplierNameRaw = requireText(
    (supplierParty['cac:PartyName'] as Record<string, unknown>)?.['cbc:Name'] ??
      (supplierParty['cac:PartyLegalEntity'] as Record<string, unknown>)?.['cbc:RegistrationName'],
    'cac:PartyName/cbc:Name',
  );

  // Identifiant fiscal du fournisseur (TVA intracommunautaire ou SIRET)
  const taxSchemes = supplierParty['cac:PartyTaxScheme'];
  const firstTaxScheme = Array.isArray(taxSchemes) ? taxSchemes[0] : taxSchemes;
  const supplierPaIdentifier =
    textOf(
      supplierParty['cbc:EndpointID'] ??
        (firstTaxScheme as Record<string, unknown>)?.['cbc:CompanyID'] ??
        (supplierParty['cac:PartyLegalEntity'] as Record<string, unknown>)?.['cbc:CompanyID'],
    ) || 'UNKNOWN';

  // Montants globaux
  const monetary = root['cac:LegalMonetaryTotal'] as Record<string, unknown> | undefined;
  if (!monetary) throw new Error('cac:LegalMonetaryTotal absent');

  const totalExclTax = numStr(monetary['cbc:TaxExclusiveAmount']);
  const totalInclTax = numStr(monetary['cbc:TaxInclusiveAmount'] ?? monetary['cbc:PayableAmount']);

  // TVA totale
  const taxTotalNode = root['cac:TaxTotal'] as Record<string, unknown> | undefined;
  const totalTax = numStr(taxTotalNode?.['cbc:TaxAmount']);

  // Lignes
  const lineNodes =
    ((root['cac:InvoiceLine'] ?? root['cac:CreditNoteLine']) as
      | Record<string, unknown>[]
      | undefined) ?? [];

  const lines: ParsedLine[] = lineNodes.map((l, idx) => {
    const lineNo = Number(textOf(l['cbc:ID'])) || idx + 1;
    const description =
      textOf(
        (l['cac:Item'] as Record<string, unknown>)?.['cbc:Description'] ??
          (l['cac:Item'] as Record<string, unknown>)?.['cbc:Name'] ??
          '',
      ) || `Ligne ${lineNo}`;

    const quantity = numStr(l['cbc:InvoicedQuantity'] ?? l['cbc:CreditedQuantity']);
    const amountExclTax = numStr(l['cbc:LineExtensionAmount']);

    // Prix unitaire
    const priceNode = l['cac:Price'] as Record<string, unknown> | undefined;
    const unitPrice = numStr(priceNode?.['cbc:PriceAmount'] ?? priceNode?.['cbc:BaseQuantity']);

    // TVA ligne
    const lineTaxTotal = l['cac:TaxTotal'] as Record<string, unknown> | undefined;
    const taxAmount = numStr(lineTaxTotal?.['cbc:TaxAmount']);

    const taxSubtotals =
      (lineTaxTotal?.['cac:TaxSubtotal'] as Record<string, unknown>[] | undefined) ?? [];
    const firstSub = taxSubtotals[0] as Record<string, unknown> | undefined;
    const taxCategory = firstSub?.['cac:TaxCategory'] as Record<string, unknown> | undefined;
    const taxRate = textOf(taxCategory?.['cbc:Percent']) || null;
    const taxCode = textOf(taxCategory?.['cbc:ID']) || null;

    // Montant TTC ligne
    const amountInclTaxNum = parseFloat(amountExclTax) + parseFloat(taxAmount || '0');
    const amountInclTax = amountInclTaxNum.toFixed(4);

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

  return {
    format: 'UBL',
    direction,
    docNumberPa,
    docDate,
    dueDate,
    currency,
    supplierPaIdentifier,
    supplierNameRaw,
    totalExclTax,
    totalTax,
    totalInclTax,
    lines,
    supplierExtracted: extractSupplier(supplierParty, supplierPaIdentifier),
  };
}
