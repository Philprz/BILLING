import { describe, expect, it } from 'vitest';
import { parseInvoiceXml } from '../../apps/api/src/services/xml-parser.service';
import { buildBusinessPartnerPayload } from '../../apps/api/src/services/sap-sl.service';

function ublSupplier(supplierXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>INV-001</cbc:ID>
  <cbc:IssueDate>2026-04-28</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>${supplierXml}</cac:Party>
  </cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">120.00</cbc:TaxInclusiveAmount>
  </cac:LegalMonetaryTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">20.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="EA">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Prestation</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>20.00</cbc:Percent>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

describe('supplier creation prefill data', () => {
  it('extracts complete UBL supplier data for the creation form', () => {
    const parsed = parseInvoiceXml(
      ublSupplier(`
        <cbc:EndpointID schemeID="0009">12345678900012</cbc:EndpointID>
        <cac:PartyIdentification><cbc:ID>12345678900012</cbc:ID></cac:PartyIdentification>
        <cac:PartyName><cbc:Name>ACME SERVICES</cbc:Name></cac:PartyName>
        <cac:PostalAddress>
          <cbc:StreetName>10 rue de la Paix</cbc:StreetName>
          <cbc:AdditionalStreetName>Bâtiment A</cbc:AdditionalStreetName>
          <cbc:CityName>Paris</cbc:CityName>
          <cbc:PostalZone>75002</cbc:PostalZone>
          <cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country>
        </cac:PostalAddress>
        <cac:PartyTaxScheme><cbc:CompanyID>FR12123456789</cbc:CompanyID></cac:PartyTaxScheme>
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>ACME SERVICES SAS</cbc:RegistrationName>
          <cbc:CompanyID>123456789</cbc:CompanyID>
        </cac:PartyLegalEntity>
        <cac:Contact>
          <cbc:Telephone>+33123456789</cbc:Telephone>
          <cbc:ElectronicMail>contact@acme.test</cbc:ElectronicMail>
        </cac:Contact>`),
      'invoice.xml',
    );

    expect(parsed.supplierNameRaw).toBe('ACME SERVICES');
    expect(parsed.supplierPaIdentifier).toBe('12345678900012');
    expect(parsed.supplierExtracted).toMatchObject({
      endpointId: '12345678900012',
      siren: '123456789',
      siret: '12345678900012',
      vatNumber: 'FR12123456789',
      street: '10 rue de la Paix',
      street2: 'Bâtiment A',
      postalCode: '75002',
      city: 'Paris',
      country: 'FR',
      email: 'contact@acme.test',
      phone: '+33123456789',
    });
  });

  it('leaves address fields empty when UBL has no supplier address', () => {
    const parsed = parseInvoiceXml(
      ublSupplier(`
        <cac:PartyName><cbc:Name>SANS ADRESSE</cbc:Name></cac:PartyName>
        <cac:PartyTaxScheme><cbc:CompanyID>FR99888777666</cbc:CompanyID></cac:PartyTaxScheme>`),
      'invoice.xml',
    );

    expect(parsed.supplierExtracted).toMatchObject({
      street: null,
      street2: null,
      postalCode: null,
      city: null,
      country: null,
      vatNumber: 'FR99888777666',
    });
  });

  it('builds a SAP BusinessPartners payload with bill-to address and contact fields', () => {
    expect(
      buildBusinessPartnerPayload({
        cardCode: 'F00042',
        cardName: 'ACME SERVICES',
        federalTaxId: '12345678900012',
        street: '10 rue de la Paix',
        street2: 'Bâtiment A',
        postalCode: '75002',
        city: 'Paris',
        country: 'FR',
        email: 'contact@acme.test',
        phone: '+33123456789',
      }),
    ).toEqual({
      CardCode: 'F00042',
      CardName: 'ACME SERVICES',
      CardType: 'cSupplier',
      FederalTaxID: '12345678900012',
      EmailAddress: 'contact@acme.test',
      Phone1: '+33123456789',
      BPAddresses: [
        {
          AddressName: 'Facturation',
          AddressType: 'bo_BillTo',
          Street: '10 rue de la Paix',
          Block: 'Bâtiment A',
          ZipCode: '75002',
          City: 'Paris',
          Country: 'FR',
        },
      ],
    });
  });

  it('does not send an EU VAT number to SAP VATRegistrationNumber when SAP expects local format', () => {
    expect(
      buildBusinessPartnerPayload({
        cardCode: 'F00042',
        cardName: 'ACME SERVICES',
        vatRegNum: 'FR12123456789',
      }),
    ).not.toHaveProperty('VATRegistrationNumber');
  });

  it('sends SAP-formatted VATRegistrationNumber when it matches the local format', () => {
    expect(
      buildBusinessPartnerPayload({
        cardCode: 'F00042',
        cardName: 'ACME SERVICES',
        vatRegNum: '123-45-67890',
      }),
    ).toMatchObject({ VATRegistrationNumber: '123-45-67890' });
  });
});
