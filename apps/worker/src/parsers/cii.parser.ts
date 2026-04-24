/**
 * Parseur CII (Cross Industry Invoice) — UN/CEFACT D16B
 *
 * Namespace racine :
 *   urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100
 *
 * TypeCode : 380 = Invoice, 381/389 = CreditNote
 *
 * Structure XML :
 *   rsm:CrossIndustryInvoice
 *     rsm:ExchangedDocument              — en-tête (ID, TypeCode, date)
 *     rsm:SupplyChainTradeTransaction
 *       ram:ApplicableHeaderTradeAgreement — parties (vendeur/acheteur)
 *       ram:ApplicableHeaderTradeSettlement — devises, totaux, TVA
 *       ram:IncludedSupplyChainTradeLineItem[] — lignes
 */

import { XMLParser } from 'fast-xml-parser';
import type { ParsedInvoice, ParsedLine } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textOf(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text']).trim();
  }
  return '';
}

function numStr(node: unknown): string {
  const s = textOf(node);
  return s !== '' ? s : '0';
}

function requireText(node: unknown, field: string): string {
  const v = textOf(node);
  if (!v) throw new Error(`Champ CII manquant ou vide : ${field}`);
  return v;
}

/** Convertit la date CII (YYYYMMDD ou YYYY-MM-DD) en YYYY-MM-DD */
function parseCiiDate(raw: string): string {
  const s = raw.trim().replace(/\D/g, '');
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return raw.trim();
}

function obj(node: unknown): Record<string, unknown> {
  return (node && typeof node === 'object' ? node : {}) as Record<string, unknown>;
}

function arr(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node as Record<string, unknown>[];
  if (node && typeof node === 'object') return [node as Record<string, unknown>];
  return [];
}

// ─── Parser XML ──────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => {
    const local = tagName.includes(':') ? tagName.split(':')[1] : tagName;
    return [
      'IncludedSupplyChainTradeLineItem',
      'ApplicableTradeTax',
      'SpecifiedTaxRegistration',
    ].includes(local);
  },
});

// ─── Parser principal ─────────────────────────────────────────────────────────

export function parseCii(xmlContent: string): ParsedInvoice {
  const doc = xmlParser.parse(xmlContent) as Record<string, unknown>;

  const root = (doc['rsm:CrossIndustryInvoice'] ?? doc['CrossIndustryInvoice']) as
    | Record<string, unknown>
    | undefined;

  if (!root) {
    throw new Error('Document CII invalide : élément racine CrossIndustryInvoice absent');
  }

  // ── En-tête ───────────────────────────────────────────────────────────────
  const header = obj(root['rsm:ExchangedDocument'] ?? root['ExchangedDocument']);

  const docNumberPa = requireText(header['ram:ID'] ?? header['ID'], 'ram:ID');
  const typeCode = textOf(header['ram:TypeCode'] ?? header['TypeCode']);
  const direction: ParsedInvoice['direction'] =
    typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';

  const issueDateTimeNode = header['ram:IssueDateTime'] ?? header['IssueDateTime'];
  const rawDate = textOf(
    obj(issueDateTimeNode)['udt:DateTimeString'] ??
      obj(issueDateTimeNode)['DateTimeString'] ??
      issueDateTimeNode,
  );
  if (!rawDate) throw new Error('CII : date IssueDateTime absente');
  const docDate = parseCiiDate(rawDate);

  // ── Transaction ───────────────────────────────────────────────────────────
  const trx = obj(root['rsm:SupplyChainTradeTransaction'] ?? root['SupplyChainTradeTransaction']);

  // ── Accord commercial (fournisseur) ───────────────────────────────────────
  const agreement = obj(
    trx['ram:ApplicableHeaderTradeAgreement'] ?? trx['ApplicableHeaderTradeAgreement'],
  );
  const seller = obj(agreement['ram:SellerTradeParty'] ?? agreement['SellerTradeParty']);

  const supplierNameRaw = requireText(
    seller['ram:Name'] ?? seller['Name'],
    'ram:SellerTradeParty/ram:Name',
  );

  const taxRegs = arr(seller['ram:SpecifiedTaxRegistration'] ?? seller['SpecifiedTaxRegistration']);
  const supplierPaIdentifier =
    textOf(obj(taxRegs[0])['ram:ID'] ?? obj(taxRegs[0])['ID']) ||
    textOf(
      obj(seller['ram:SpecifiedLegalOrganization'] ?? seller['SpecifiedLegalOrganization'])[
        'ram:ID'
      ] ??
        obj(seller['ram:SpecifiedLegalOrganization'] ?? seller['SpecifiedLegalOrganization'])['ID'],
    ) ||
    'UNKNOWN';

  // ── Règlement (settlement) ────────────────────────────────────────────────
  const settlement = obj(
    trx['ram:ApplicableHeaderTradeSettlement'] ?? trx['ApplicableHeaderTradeSettlement'],
  );

  const currency = requireText(
    settlement['ram:InvoiceCurrencyCode'] ?? settlement['InvoiceCurrencyCode'],
    'ram:InvoiceCurrencyCode',
  );

  // Échéance
  const payTerms = obj(
    settlement['ram:SpecifiedTradePaymentTerms'] ?? settlement['SpecifiedTradePaymentTerms'],
  );
  const dueDateTimeNode = obj(payTerms['ram:DueDateDateTime'] ?? payTerms['DueDateDateTime']);
  const rawDue = textOf(
    dueDateTimeNode['udt:DateTimeString'] ?? dueDateTimeNode['DateTimeString'] ?? dueDateTimeNode,
  );
  const dueDate = rawDue ? parseCiiDate(rawDue) : null;

  // Totaux
  const monetarySums = obj(
    settlement['ram:SpecifiedTradeSettlementHeaderMonetarySummation'] ??
      settlement['SpecifiedTradeSettlementHeaderMonetarySummation'],
  );
  const totalExclTax = numStr(
    monetarySums['ram:TaxBasisTotalAmount'] ?? monetarySums['TaxBasisTotalAmount'],
  );
  const totalInclTax = numStr(
    monetarySums['ram:GrandTotalAmount'] ?? monetarySums['GrandTotalAmount'],
  );

  const taxTotalAmountNode = monetarySums['ram:TaxTotalAmount'] ?? monetarySums['TaxTotalAmount'];
  const allTaxes = arr(settlement['ram:ApplicableTradeTax'] ?? settlement['ApplicableTradeTax']);
  const totalTax =
    textOf(taxTotalAmountNode) ||
    allTaxes
      .reduce(
        (sum, t) =>
          sum + parseFloat(numStr(obj(t)['ram:CalculatedAmount'] ?? obj(t)['CalculatedAmount'])),
        0,
      )
      .toFixed(4);

  // ── Lignes ────────────────────────────────────────────────────────────────
  const lineNodes = arr(
    trx['ram:IncludedSupplyChainTradeLineItem'] ?? trx['IncludedSupplyChainTradeLineItem'],
  );

  const lines: ParsedLine[] = lineNodes.map((l, idx) => {
    const docLine = obj(
      l['ram:AssociatedDocumentLineDocument'] ?? l['AssociatedDocumentLineDocument'],
    );
    const lineNo = Number(textOf(docLine['ram:LineID'] ?? docLine['LineID'])) || idx + 1;

    const product = obj(l['ram:SpecifiedTradeProduct'] ?? l['SpecifiedTradeProduct']);
    const description =
      textOf(
        product['ram:Name'] ??
          product['Name'] ??
          product['ram:Description'] ??
          product['Description'],
      ) || `Ligne ${lineNo}`;

    const delivery = obj(l['ram:SpecifiedLineTradeDelivery'] ?? l['SpecifiedLineTradeDelivery']);
    const quantity = numStr(delivery['ram:BilledQuantity'] ?? delivery['BilledQuantity']);

    const lineSettlement = obj(
      l['ram:SpecifiedLineTradeSettlement'] ?? l['SpecifiedLineTradeSettlement'],
    );
    const monSums = obj(
      lineSettlement['ram:SpecifiedTradeSettlementLineMonetarySummation'] ??
        lineSettlement['SpecifiedTradeSettlementLineMonetarySummation'],
    );
    const amountExclTax = numStr(monSums['ram:LineTotalAmount'] ?? monSums['LineTotalAmount']);

    const lineAgreement = obj(
      l['ram:SpecifiedLineTradeAgreement'] ?? l['SpecifiedLineTradeAgreement'],
    );
    const priceNode = obj(
      lineAgreement['ram:NetPriceProductTradePrice'] ?? lineAgreement['NetPriceProductTradePrice'],
    );
    const unitPrice =
      numStr(priceNode['ram:ChargeAmount'] ?? priceNode['ChargeAmount']) || amountExclTax;

    const lineTaxes = arr(
      lineSettlement['ram:ApplicableTradeTax'] ?? lineSettlement['ApplicableTradeTax'],
    );
    const firstLineTax = obj(lineTaxes[0]);
    const taxAmount = numStr(
      firstLineTax['ram:CalculatedAmount'] ?? firstLineTax['CalculatedAmount'],
    );
    const taxRate =
      textOf(firstLineTax['ram:RateApplicablePercent'] ?? firstLineTax['RateApplicablePercent']) ||
      null;
    const taxCode = textOf(firstLineTax['ram:TypeCode'] ?? firstLineTax['TypeCode']) || null;

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

  return {
    format: 'CII',
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
  };
}
