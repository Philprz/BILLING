export interface ParsedLine {
  lineNo: number;
  description: string;
  quantity: string; // Decimal-compatible string
  unitPrice: string;
  amountExclTax: string;
  taxRate: string | null; // ex. "20.00"
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

export interface ParsedInvoice {
  /** Format réellement détecté (pour alimenter invoice.format) */
  format: 'UBL' | 'CII' | 'FACTUR_X' | 'PDF_ONLY';
  direction: 'INVOICE' | 'CREDIT_NOTE' | 'ADVANCE_INVOICE' | 'CORRECTIVE_INVOICE';
  docNumberPa: string;
  docDate: string; // YYYY-MM-DD
  dueDate: string | null;
  currency: string; // ISO 4217
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  totalExclTax: string;
  totalTax: string;
  totalInclTax: string;
  prepaidAmount: string | null; // BT-113 (null si absent ou 0)
  allowanceTotal: string | null; // BT-107 — total remises document (null si absent ou 0)
  chargeTotal: string | null; // BT-108 — total majorations document (null si absent ou 0)
  correctedInvoiceRef: string | null; // BT-3 — ID de la facture originale corrigée (null si absent)
  typeTransaction: string | null; // CIUS-FR : '1'=Biens, '2'=Services, '3'=Mixte (null si absent)
  lines: ParsedLine[];
  supplierExtracted: SupplierExtracted | null;
}
