export interface ParsedLine {
  lineNo:        number;
  description:   string;
  quantity:      string;   // Decimal-compatible string
  unitPrice:     string;
  amountExclTax: string;
  taxRate:       string | null;  // ex. "20.00"
  taxCode:       string | null;
  taxAmount:     string;
  amountInclTax: string;
}

export interface ParsedInvoice {
  /** Format réellement détecté (pour alimenter invoice.format) */
  format:                'UBL' | 'CII' | 'FACTUR_X' | 'PDF_ONLY';
  direction:             'INVOICE' | 'CREDIT_NOTE';
  docNumberPa:           string;
  docDate:               string;   // YYYY-MM-DD
  dueDate:               string | null;
  currency:              string;   // ISO 4217
  supplierPaIdentifier:  string;
  supplierNameRaw:       string;
  totalExclTax:          string;
  totalTax:              string;
  totalInclTax:          string;
  lines:                 ParsedLine[];
}
