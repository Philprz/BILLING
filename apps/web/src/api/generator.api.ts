import { apiFetch } from './client';

export interface GenLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  accountingCode: string; // Compte de charge classe 6 (obligatoire, ex: 622600)
  accountingLabel?: string; // Libellé du compte (affiché dans le PDF)
}

export interface GenSupplier {
  name: string;
  legalForm?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  taxId?: string;
  siret?: string;
  iban?: string;
  bic?: string;
  phone?: string;
  email?: string;
}

export interface InvoiceGenData {
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  currency: string;
  direction: 'INVOICE' | 'CREDIT_NOTE';
  supplier: GenSupplier;
  buyerName?: string;
  buyerSiret?: string;
  buyerVatNumber?: string;
  lines: GenLine[];
  note?: string;
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

export interface GeneratedInvoice {
  xmlContent: string;
  xmlFilename: string;
  pdfFilename: string;
  zipFilename: string;
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

export interface SapSupplier {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
}

export async function apiSearchSapSuppliers(
  search: string,
): Promise<{ items: SapSupplier[]; total: number }> {
  return apiFetch(`/api/invoice-generator/suppliers?search=${encodeURIComponent(search)}&limit=20`);
}

export async function apiEnrichSupplier(siren: string): Promise<SupplierEnrichment> {
  return apiFetch('/api/invoice-generator/enrich-supplier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siren }),
  });
}

export async function apiGenerateInvoice(data: InvoiceGenData): Promise<GeneratedInvoice> {
  return apiFetch('/api/invoice-generator/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function getDownloadUrl(filename: string): string {
  return `/api/invoice-generator/download/${encodeURIComponent(filename)}`;
}
