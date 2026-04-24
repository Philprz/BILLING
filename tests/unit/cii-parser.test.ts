import { describe, expect, it } from 'vitest';
import { parseCii } from '../../apps/worker/src/parsers/cii.parser';

// ── Fixture XML CII minimal mais valide ───────────────────────────────────────

const CII_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">

  <rsm:ExchangedDocument>
    <ram:ID>CII-2026-001</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">20260415</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Fournisseur CII SARL</ram:Name>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">FR12345678901</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>

    <ram:ApplicableHeaderTradeDelivery />

    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>40.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:RateApplicablePercent>20</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount>40.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>240.00</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>

    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>1</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>Prestation de conseil</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>100.00</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:CalculatedAmount>40.00</ram:CalculatedAmount>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:RateApplicablePercent>20</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>200.00</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

const CII_CREDIT_NOTE = CII_INVOICE.replace(
  '<ram:TypeCode>380</ram:TypeCode>',
  '<ram:TypeCode>381</ram:TypeCode>',
);

const CII_MISSING_SELLER = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument>
    <ram:ID>CII-ERR-001</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString>20260415</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name></ram:Name></ram:SellerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery />
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>100</ram:TaxBasisTotalAmount>
        <ram:GrandTotalAmount>120</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseCii', () => {
  it('parses a valid CII invoice', () => {
    const result = parseCii(CII_INVOICE);

    expect(result.format).toBe('CII');
    expect(result.direction).toBe('INVOICE');
    expect(result.docNumberPa).toBe('CII-2026-001');
    expect(result.docDate).toBe('2026-04-15');
    expect(result.currency).toBe('EUR');
    expect(result.supplierNameRaw).toBe('Fournisseur CII SARL');
    expect(result.supplierPaIdentifier).toBe('FR12345678901');
    expect(result.totalExclTax).toBe('200.00');
    expect(result.totalTax).toBe('40.00');
    expect(result.totalInclTax).toBe('240.00');
  });

  it('parses lines correctly', () => {
    const { lines } = parseCii(CII_INVOICE);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineNo: 1,
      description: 'Prestation de conseil',
      quantity: '2',
      unitPrice: '100.00',
      amountExclTax: '200.00',
      taxRate: '20',
      taxCode: 'VAT',
    });
    expect(parseFloat(lines[0].taxAmount)).toBeCloseTo(40, 1);
  });

  it('detects credit note TypeCode 381', () => {
    const result = parseCii(CII_CREDIT_NOTE);
    expect(result.direction).toBe('CREDIT_NOTE');
  });

  it('throws when seller name is missing', () => {
    expect(() => parseCii(CII_MISSING_SELLER)).toThrow('ram:SellerTradeParty/ram:Name');
  });

  it('throws when root element is absent', () => {
    expect(() => parseCii('<root/>')).toThrow('CrossIndustryInvoice absent');
  });
});
