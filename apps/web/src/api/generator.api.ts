import { apiFetch } from './client';

// Remise (allowance) ou charge (charge) — niveau ligne (BG-27/28) ou document (BG-20/21).
// Au niveau document, vatCategory est obligatoire ; au niveau ligne il est ignoré (hérité).
export interface AllowanceChargeInput {
  isCharge: boolean; // false = remise, true = charge
  amount: number; // BT-136/141 (ligne) ou BT-92/99 (document)
  reason?: string; // BT-139/144 ou BT-97/104
  reasonCode?: string; // BT-140/145 (UNTDID 7161) ou BT-98 (UNTDID 5189)
  vatCategory?: string; // BT-95/102 — document uniquement
  vatRate?: number; // BT-96/103 — document uniquement
}

// BG-1 / BT-21-22 — note de facture : texte + code sujet optionnel (UNTDID 4451).
export interface InvoiceNote {
  subjectCode?: string; // BT-21
  text: string; // BT-22
}

// BG-10 / BT-59-61 — partie bénéficiaire / factor (affacturage).
export interface PayeeInput {
  name: string;
  identifier?: string;
  legalId?: string;
}

export interface GenLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxCategoryCode?: 'S' | 'Z' | 'E' | 'AE' | 'K' | 'O';
  taxExemptionReasonCode?: string;
  taxExemptionReason?: string;
  accountingCode: string; // Compte de charge classe 6 (obligatoire, ex: 622600)
  accountingLabel?: string; // Libellé du compte (affiché dans le PDF)
  allowanceCharges?: AllowanceChargeInput[]; // BG-27/28 — remises/charges de ligne
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
  // Code de routage CTC (EAS 0225) — requis pour un vendeur étranger/OSS sans EAS de TVA national
  routingCode?: string;
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
  taxCurrency?: string; // BT-6 — devise de comptabilisation TVA (défaut EUR)
  taxExchangeRate?: number; // taux de conversion devise facture → devise compta. (BT-111)
  deliveryDate?: string; // BT-72 — date de livraison / fin de prestation
  direction:
    | 'INVOICE'
    | 'CREDIT_NOTE'
    | 'ADVANCE_INVOICE'
    | 'CORRECTIVE_INVOICE'
    | 'ADVANCE_CREDIT_NOTE' // 503 — avoir de facture d'acompte
    | 'SELF_BILLED' // 389 — autofacturation
    | 'FACTORING'; // 393 — affacturage
  prepaidAmount?: number; // BT-113 — montant acompte déjà versé
  paymentStatus?: 'unpaid' | 'paid'; // pilote le chiffre 1/2 du cadre BT-23
  paymentDate?: string; // BT-9 — date de paiement (cadre chiffre 2 / BR-FR-CO-09)
  correctedInvoiceRef?: string; // BT-3 — ID de la facture originale corrigée (TypeCode 384)
  supplier: GenSupplier;
  buyerName?: string;
  buyerSiret?: string;
  buyerVatNumber?: string;
  buyerLegalForm?: string;
  buyerAddress?: string;
  buyerCity?: string;
  buyerPostalCode?: string;
  buyerCountry?: string;
  // Code de routage CTC (EAS 0225) acheteur — pour identifiants TVA OSS/étrangers sans EAS national
  buyerRoutingCode?: string;
  buyerReference?: string;
  orderReference?: string;
  salesOrderId?: string;
  typeTransaction?: '1' | '2' | '3';
  optionTVA?: 'S' | 'E';
  lines: GenLine[];
  documentAllowanceCharges?: AllowanceChargeInput[]; // BG-20/21 — remises/charges document
  payee?: PayeeInput; // BG-10 — bénéficiaire / factor (obligatoire si FACTORING)
  notes?: InvoiceNote[]; // BG-1 — mentions structurées (BT-21/22)
  note?: string; // déprécié — note libre unique (compat ascendante)
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
    prepaidAmount: number;
    payableAmount: number;
    currency: string;
    lineCount: number;
    cadreCode: string; // BT-23 — ex. « S1 »
    cadreLabel: string;
    cadreWarning?: string; // alerte divergence lignes vs typeTransaction
    peppolRoutable: boolean; // BT-34/49 — false si un EndpointID a été omis (non routable Peppol)
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
