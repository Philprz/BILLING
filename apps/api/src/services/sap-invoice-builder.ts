/**
 * Constructeurs de payloads SAP B1 Service Layer.
 * CDC §7.1 (PurchaseInvoice) et §7.2 (JournalEntry).
 *
 * Règles de résolution :
 *  accountCode  : chosenAccountCode > suggestedAccountCode (obligatoire)
 *  taxCode      : chosenTaxCodeB1 > suggestedTaxCodeB1 > TAX_RATE_MAPPING
 *  costCenter   : chosenCostCenter > suggestedCostCenter
 *  Si aucun accountCode sur une ligne → ligne ignorée
 */

import type { Prisma } from '@pa-sap-bridge/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceData {
  docNumberPa: string;
  paSource: string;
  paMessageId: string;
  direction: string; // 'INVOICE' | 'CREDIT_NOTE'
  supplierB1Cardcode: string;
  supplierNameRaw: string;
  docDate: Date;
  dueDate: Date | null;
  currency: string;
  // Taux de change document/devise locale (1 si même devise). Requis par SAP B1 quand DocCurrency est fourni.
  docRate?: number;
}

export interface LineData {
  lineNo: number;
  description: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  amountExclTax: Prisma.Decimal;
  taxRate: Prisma.Decimal | null;
  taxAmount: Prisma.Decimal;
  amountInclTax: Prisma.Decimal;
  chosenAccountCode: string | null;
  suggestedAccountCode: string | null;
  chosenCostCenter?: string | null;
  suggestedCostCenter?: string | null;
  chosenTaxCodeB1: string | null;
  suggestedTaxCodeB1: string | null;
}

export interface BuildResult {
  payload: unknown;
  skippedLines: number[]; // lignes sans accountCode
  balanceWarning: string | null;
}

export interface ResolvedLineForSap {
  accountCode: string | null;
  costCenter: string | null;
  taxCode: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function resolveAccountCode(l: LineData): string | null {
  return l.chosenAccountCode ?? l.suggestedAccountCode ?? null;
}

function resolveTaxCode(l: LineData, taxRateMap: Record<string, string>): string | null {
  if (l.chosenTaxCodeB1) return l.chosenTaxCodeB1;
  if (l.suggestedTaxCodeB1) return l.suggestedTaxCodeB1;
  const rate = l.taxRate?.toString();
  if (rate && taxRateMap[rate]) return taxRateMap[rate];
  return null;
}

export function resolveLineForSap(
  line: LineData,
  taxRateMap: Record<string, string>,
): ResolvedLineForSap {
  return {
    accountCode: resolveAccountCode(line),
    costCenter: line.chosenCostCenter ?? null,
    taxCode: resolveTaxCode(line, taxRateMap),
  };
}

// ─── A1 — Purchase Invoice / Credit Note ─────────────────────────────────────
// CDC §7.1 — DocType dDocument_Service, LineTotal = amountExclTax

export function buildPurchaseDocPayload(
  invoice: InvoiceData,
  lines: LineData[],
  attachmentEntry: number,
  taxRateMap: Record<string, string>,
): BuildResult {
  const skippedLines: number[] = [];
  const documentLines: unknown[] = [];

  for (const l of lines) {
    const resolved = resolveLineForSap(l, taxRateMap);
    if (!resolved.accountCode) {
      skippedLines.push(l.lineNo);
      continue;
    }

    const docLine: Record<string, unknown> = {
      LineType: 'acAccount',
      ItemDescription: l.description.slice(0, 100),
      // Quantité fixe à 1 + UnitPrice = montant HT exact (évite les erreurs d'arrondi qty×PU)
      Quantity: 1,
      UnitPrice: Number(l.amountExclTax),
      AccountCode: resolved.accountCode,
    };
    if (resolved.taxCode) docLine.TaxCode = resolved.taxCode;
    if (resolved.costCenter) docLine.CostingCode = resolved.costCenter;
    documentLines.push(docLine);
  }

  const payload: Record<string, unknown> = {
    CardCode: invoice.supplierB1Cardcode,
    DocType: 'dDocument_Service',
    DocDate: toISODate(invoice.docDate),
    DocDueDate: toISODate(invoice.dueDate ?? invoice.docDate),
    TaxDate: toISODate(invoice.docDate),
    NumAtCard: invoice.docNumberPa,
    Comments: `PA: ${invoice.paSource} / msg ${invoice.paMessageId}`,
    U_PA_REF: invoice.paMessageId,
    DocCurrency: invoice.currency,
    // DocRate requis par SAP B1 quand DocCurrency est fourni — évite [OPCH.DocRate] = 0.
    DocRate: invoice.docRate ?? 1,
    DocumentLines: documentLines,
  };
  if (attachmentEntry > 0) payload.AttachmentEntry = attachmentEntry;

  return { payload, skippedLines, balanceWarning: null };
}

// ─── A2 — Journal Entry ───────────────────────────────────────────────────────
// CDC §7.2 — lignes charge HT + lignes TVA + contrepartie fournisseur TTC
//
// Structure pour une facture :
//   Débit  : compte de charge (amountExclTax) × N lignes
//   Débit  : compte TVA déductible (taxAmount) × taux distinct  [si apTaxAccountMap fourni]
//   Crédit : compte fournisseur ShortName=CardCode (totalTtc)
//
// Pour avoir (CREDIT_NOTE) : débit ↔ crédit inversés.

export function buildJournalEntryPayload(
  invoice: InvoiceData,
  lines: LineData[],
  attachmentEntry: number,
  taxRateMap: Record<string, string>,
  apTaxAccountMap: Record<string, string> = {}, // ex. {"20.00": "445660"}
): BuildResult {
  const skippedLines: number[] = [];
  const jeLines: unknown[] = [];
  const isCreditNote = invoice.direction === 'CREDIT_NOTE';

  // Totaux pour le contrôle d'équilibre
  let totalDebit = 0;
  let totalCredit = 0;

  // TVA agrégée par taux (pour regrouper les lignes TVA)
  const taxByRate = new Map<string, { amount: number; account: string | null }>();
  // Cumul TVA brut (pour calculer le TTC du fournisseur indépendamment des comptes)
  let totalTvaGross = 0;

  for (const l of lines) {
    const resolved = resolveLineForSap(l, taxRateMap);
    if (!resolved.accountCode) {
      skippedLines.push(l.lineNo);
      continue;
    }

    const ht = Math.abs(Number(l.amountExclTax));
    const tva = Math.abs(Number(l.taxAmount));

    // Ligne de charge HT
    const chargeLine: Record<string, unknown> = {
      AccountCode: resolved.accountCode,
      Debit: isCreditNote ? 0 : ht,
      Credit: isCreditNote ? ht : 0,
      LineMemo: l.description.slice(0, 100),
    };
    if (resolved.taxCode) chargeLine.TaxCode = resolved.taxCode;
    jeLines.push(chargeLine);

    if (isCreditNote) {
      totalCredit += ht;
    } else {
      totalDebit += ht;
    }

    // Agréger la TVA par taux pour une ligne TVA unique par taux
    if (tva > 0 && l.taxRate !== null) {
      const rateKey = Number(l.taxRate).toFixed(2);
      const taxAcct = apTaxAccountMap[rateKey] ?? null;
      const existing = taxByRate.get(rateKey);
      if (existing) {
        existing.amount += tva;
      } else {
        taxByRate.set(rateKey, { amount: tva, account: taxAcct });
      }
      totalTvaGross += tva;
    }
  }

  // Lignes TVA déductible (une par taux distinct)
  for (const [rateKey, { amount, account }] of taxByRate) {
    if (!account) continue; // pas de compte configuré pour ce taux → skip
    const tvaLine: Record<string, unknown> = {
      AccountCode: account,
      Debit: isCreditNote ? 0 : amount,
      Credit: isCreditNote ? amount : 0,
      LineMemo: `TVA ${rateKey}%`,
    };
    jeLines.push(tvaLine);
    if (isCreditNote) {
      totalCredit += amount;
    } else {
      totalDebit += amount;
    }
  }

  // Ligne de contrepartie fournisseur (ShortName = CardCode du fournisseur)
  // La contrepartie est toujours en TTC (HT + TVA), indépendamment des comptes TVA configurés.
  const totalHt = isCreditNote ? totalCredit : totalDebit;
  const totalTtc = totalHt + totalTvaGross;
  if (totalTtc > 0) {
    jeLines.push({
      ShortName: invoice.supplierB1Cardcode,
      Debit: isCreditNote ? totalTtc : 0,
      Credit: isCreditNote ? 0 : totalTtc,
      LineMemo: `${invoice.supplierNameRaw} — ${invoice.docNumberPa}`,
    });
    if (isCreditNote) {
      totalDebit += totalTtc;
    } else {
      totalCredit += totalTtc;
    }
  }

  // Contrôle d'équilibre (CDC §7.2)
  const imbalance = Math.abs(totalDebit - totalCredit);
  const balanceWarning =
    imbalance > 0.01
      ? `Écriture déséquilibrée : débit ${totalDebit.toFixed(2)} ≠ crédit ${totalCredit.toFixed(2)} (écart ${imbalance.toFixed(2)} €). Vérifiez les comptes TVA dans les paramètres.`
      : null;

  const payload: Record<string, unknown> = {
    Memo: `${invoice.docNumberPa} — ${invoice.supplierNameRaw}`,
    Reference: invoice.docNumberPa,
    Reference2: invoice.paMessageId,
    ReferenceDate: toISODate(invoice.docDate),
    DueDate: toISODate(invoice.dueDate ?? invoice.docDate),
    JournalEntryLines: jeLines,
  };
  if (attachmentEntry > 0) payload.AttachmentEntry = attachmentEntry;

  return { payload, skippedLines, balanceWarning };
}
