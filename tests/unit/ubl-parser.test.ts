import { describe, expect, it } from 'vitest';
import { parseUbl } from '../../apps/worker/src/parsers/ubl.parser';

// ── Fixtures UBL minimales mais valides ───────────────────────────────────────

/** Construit une facture UBL (racine Invoice) avec un InvoiceTypeCode donné. */
function ublInvoice(typeCode: string, extra: { taxTotal?: string } = {}): string {
  const taxTotal =
    extra.taxTotal ??
    `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">40.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">200.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">40.00</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>20.00</cbc:Percent>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice
  xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>UBL-${typeCode}-001</cbc:ID>
  <cbc:IssueDate>2026-06-04</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Fournisseur UBL SARL</cbc:Name></cac:PartyName>
      <cac:PartyLegalEntity><cbc:CompanyID>38291746500031</cbc:CompanyID></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
${taxTotal}
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">200.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">240.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">240.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">200.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="EUR">40.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Description>Prestation</cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

/** Avoir d'acompte 503 — racine CreditNote. */
const UBL_503 = `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote
  xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>UBL-503-001</cbc:ID>
  <cbc:IssueDate>2026-06-04</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>503</cbc:CreditNoteTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Fournisseur UBL SARL</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">20.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">120.00</cbc:TaxInclusiveAmount>
  </cac:LegalMonetaryTotal>
  <cac:CreditNoteLine>
    <cbc:ID>1</cbc:ID>
    <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Avoir acompte</cbc:Description></cac:Item>
  </cac:CreditNoteLine>
</CreditNote>`;

/**
 * Facture multidevise : deux cac:TaxTotal. Le premier en devise du document
 * (USD, porteur des TaxSubtotal), le second en devise de comptabilisation
 * (EUR, BT-111, cbc:TaxAmount seul). On vérifie que la TVA totale est extraite
 * du bloc porteur des TaxSubtotal (BT-110) et non du bloc réduit (BT-111).
 */
const UBL_MULTI_TAXTOTAL = ublInvoice('380', {
  taxTotal: `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="USD">40.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="USD">200.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="USD">40.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">36.50</cbc:TaxAmount>
  </cac:TaxTotal>`,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseUbl — directions UNTDID 1001', () => {
  it('mappe InvoiceTypeCode 389 → SELF_BILLED (et non plus CREDIT_NOTE)', () => {
    const r = parseUbl(ublInvoice('389'));
    expect(r.direction).toBe('SELF_BILLED');
    expect(r.direction).not.toBe('CREDIT_NOTE');
    expect(r.format).toBe('UBL');
  });

  it('mappe InvoiceTypeCode 393 → FACTORING', () => {
    expect(parseUbl(ublInvoice('393')).direction).toBe('FACTORING');
  });

  it('mappe TypeCode 503 (CreditNote) → ADVANCE_CREDIT_NOTE', () => {
    const r = parseUbl(UBL_503);
    expect(r.direction).toBe('ADVANCE_CREDIT_NOTE');
    expect(r.totalTax).toBe('20.00');
  });

  it('conserve les mappings existants 380/381/386/384', () => {
    expect(parseUbl(ublInvoice('380')).direction).toBe('INVOICE');
    expect(parseUbl(ublInvoice('381')).direction).toBe('CREDIT_NOTE');
    expect(parseUbl(ublInvoice('386')).direction).toBe('ADVANCE_INVOICE');
    expect(parseUbl(ublInvoice('384')).direction).toBe('CORRECTIVE_INVOICE');
  });
});

describe('parseUbl — multi-TaxTotal', () => {
  it('extrait la TVA totale (BT-110) du TaxTotal porteur des TaxSubtotal', () => {
    const r = parseUbl(UBL_MULTI_TAXTOTAL);
    // 40.00 (bloc devise document) et non 36.50 (bloc BT-111 réduit)
    expect(r.totalTax).toBe('40.00');
  });

  it('reste inchangé sur une facture mono-TaxTotal (compat ascendante)', () => {
    const r = parseUbl(ublInvoice('380'));
    expect(r.totalTax).toBe('40.00');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].taxAmount).toBe('40.00');
  });
});
