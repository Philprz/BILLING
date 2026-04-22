/**
 * Constructeurs de payloads SAP B1 Service Layer.
 *
 * Prend les données normalisées de la DB et produit les structures
 * JSON attendues par l'API SAP B1 SL.
 *
 * Règles :
 * - accountCode : chosenAccountCode > suggestedAccountCode (obligatoire en mode service)
 * - taxCode     : chosenTaxCodeB1 > suggestedTaxCodeB1 > dérivé de taxRate via TAX_RATE_MAPPING
 * - Si aucun accountCode sur une ligne → ligne ignorée (warning)
 */

import type { Prisma } from '@pa-sap-bridge/database';

// ─── Types internes ───────────────────────────────────────────────────────────

export interface InvoiceData {
  docNumberPa:        string;
  direction:          string;  // 'INVOICE' | 'CREDIT_NOTE'
  supplierB1Cardcode: string;
  docDate:            Date;
  dueDate:            Date | null;
  currency:           string;
  supplierNameRaw:    string;
}

export interface LineData {
  lineNo:               number;
  description:          string;
  quantity:             Prisma.Decimal;
  unitPrice:            Prisma.Decimal;
  amountExclTax:        Prisma.Decimal;
  taxRate:              Prisma.Decimal | null;
  taxAmount:            Prisma.Decimal;
  amountInclTax:        Prisma.Decimal;
  chosenAccountCode:    string | null;
  suggestedAccountCode: string | null;
  chosenTaxCodeB1:      string | null;
  suggestedTaxCodeB1:   string | null;
}

export interface BuildResult {
  payload: unknown;
  skippedLines: number[];  // numéros des lignes sans accountCode
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function resolveAccountCode(l: LineData): string | null {
  return l.chosenAccountCode ?? l.suggestedAccountCode ?? null;
}

/**
 * Résout le code TVA SAP B1.
 * Priorité : choisi > suggéré > mapping automatique taxRate→code > null
 */
function resolveTaxCode(l: LineData, taxRateMap: Record<string, string>): string | null {
  if (l.chosenTaxCodeB1)    return l.chosenTaxCodeB1;
  if (l.suggestedTaxCodeB1) return l.suggestedTaxCodeB1;
  if (l.taxRate !== null) {
    const rateStr = Number(l.taxRate).toFixed(2);
    return taxRateMap[rateStr] ?? null;
  }
  return null;
}

// ─── Purchase Invoice / Credit Note ──────────────────────────────────────────

export function buildPurchaseDocPayload(
  invoice:         InvoiceData,
  lines:           LineData[],
  attachmentEntry: number,
  taxRateMap:      Record<string, string>,
): BuildResult {

  const skippedLines: number[] = [];
  const documentLines: unknown[] = [];

  for (const l of lines) {
    const accountCode = resolveAccountCode(l);
    if (!accountCode) {
      skippedLines.push(l.lineNo);
      continue;
    }

    const taxCode = resolveTaxCode(l, taxRateMap);
    const line: Record<string, unknown> = {
      ItemDescription: l.description.slice(0, 100),
      Quantity:        Number(l.quantity),
      UnitPrice:       Number(l.unitPrice),
      AccountCode:     accountCode,
    };
    if (taxCode) line.TaxCode = taxCode;
    documentLines.push(line);
  }

  const payload: Record<string, unknown> = {
    CardCode:        invoice.supplierB1Cardcode,
    DocDate:         toISODate(invoice.docDate),
    DocDueDate:      toISODate(invoice.dueDate ?? invoice.docDate),
    DocCurrency:     invoice.currency,
    AttachmentEntry: attachmentEntry,
    DocumentLines:   documentLines,
  };

  return { payload, skippedLines };
}

// ─── Journal Entry ────────────────────────────────────────────────────────────

/**
 * Journal Entry : une ligne de débit par ligne de facture + une ligne de crédit
 * globale sur le fournisseur SAP B1.
 *
 * Pour les avoir (CREDIT_NOTE), les débits et crédits sont inversés.
 */
export function buildJournalEntryPayload(
  invoice:         InvoiceData,
  lines:           LineData[],
  attachmentEntry: number,
  taxRateMap:      Record<string, string>,
): BuildResult {

  const skippedLines: number[] = [];
  const jeLines: unknown[] = [];
  let totalTtc = 0;

  const isCreditNote = invoice.direction === 'CREDIT_NOTE';

  for (const l of lines) {
    const accountCode = resolveAccountCode(l);
    if (!accountCode) {
      skippedLines.push(l.lineNo);
      continue;
    }

    const amount  = Math.abs(Number(l.amountExclTax));
    const taxCode = resolveTaxCode(l, taxRateMap);
    totalTtc     += Math.abs(Number(l.amountInclTax));

    // Pour un avoir : on crédite le compte de charge (logique inversée)
    const entry: Record<string, unknown> = {
      AccountCode: accountCode,
      Debit:       isCreditNote ? 0 : amount,
      Credit:      isCreditNote ? amount : 0,
      LineMemo:    l.description.slice(0, 100),
    };
    if (taxCode) entry.TaxCode = taxCode;
    jeLines.push(entry);
  }

  // Ligne de contrepartie fournisseur.
  // Sur SAP B1, une écriture manuelle vers un tiers se poste via ShortName=CardCode.
  if (totalTtc > 0) {
    jeLines.push({
      ShortName:   invoice.supplierB1Cardcode,
      Debit:       isCreditNote ? totalTtc : 0,
      Credit:      isCreditNote ? 0 : totalTtc,
      LineMemo:    `${invoice.supplierNameRaw} — ${invoice.docNumberPa}`,
    });
  }

  const payload: Record<string, unknown> = {
    Memo:            `${invoice.docNumberPa} — ${invoice.supplierNameRaw}`,
    ReferenceDate:   toISODate(invoice.docDate),
    DueDate:         toISODate(invoice.dueDate ?? invoice.docDate),
    AttachmentEntry: attachmentEntry,
    JournalEntryLines: jeLines,
  };

  return { payload, skippedLines };
}
