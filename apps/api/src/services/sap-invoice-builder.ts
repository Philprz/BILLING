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
  // Commentaire libre utilisateur — remonté dans Comments (PurchaseInvoice) ou Memo (JournalEntry).
  comment?: string | null;
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

  // Si l'utilisateur a saisi un commentaire, il prend la place du Comments par
  // défaut. La traçabilité PA reste portée par U_PA_REF (champ UDF dédié).
  const userComment = invoice.comment?.trim();
  const comments =
    userComment && userComment.length > 0
      ? userComment.slice(0, 254)
      : `PA: ${invoice.paSource} / msg ${invoice.paMessageId}`;

  const payload: Record<string, unknown> = {
    CardCode: invoice.supplierB1Cardcode,
    DocType: 'dDocument_Service',
    DocDate: toISODate(invoice.docDate),
    DocDueDate: toISODate(invoice.dueDate ?? invoice.docDate),
    TaxDate: toISODate(invoice.docDate),
    NumAtCard: invoice.docNumberPa,
    Comments: comments,
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
//   Débit  : compte TVA déductible (taxAmount) × code TVA distinct  [si compte présent dans le cache]
//   Crédit : compte fournisseur ShortName=CardCode (totalTtc)
//
// La ventilation TVA se fait par code TVA SAP (pas par taux) : chaque code a son
// propre compte de TVA déductible dans SAP (champ TaxAccount d'OVTG), récupéré
// au sync via VatGroupCache. Deux codes au même taux mais comptes différents
// produisent ainsi deux lignes JE distinctes.
//
// Pour avoir (CREDIT_NOTE) : débit ↔ crédit inversés.

export function buildJournalEntryPayload(
  invoice: InvoiceData,
  lines: LineData[],
  attachmentEntry: number,
  taxRateMap: Record<string, string>,
  vatAccountByCode: Record<string, string | null> = {}, // ex. {"D4": "445660"}
): BuildResult {
  const skippedLines: number[] = [];
  const jeLines: unknown[] = [];
  const isCreditNote = invoice.direction === 'CREDIT_NOTE';

  // Totaux pour le contrôle d'équilibre
  let totalDebit = 0;
  let totalCredit = 0;

  // TVA agrégée par code TVA SAP (une ligne JE par code distinct)
  const taxByCode = new Map<
    string,
    { amount: number; account: string | null; rate: number | null }
  >();
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

    // Agréger la TVA par code TVA. Sans code résolu, pas de compte possible → on
    // n'agrège pas (cohérent avec l'ancien comportement quand le mapping par taux
    // n'avait pas d'entrée).
    if (tva > 0 && resolved.taxCode) {
      const codeKey = resolved.taxCode;
      const taxAcct = vatAccountByCode[codeKey] ?? null;
      const existing = taxByCode.get(codeKey);
      if (existing) {
        existing.amount += tva;
      } else {
        taxByCode.set(codeKey, {
          amount: tva,
          account: taxAcct,
          rate: l.taxRate !== null ? Number(l.taxRate) : null,
        });
      }
      totalTvaGross += tva;
    }
  }

  // Lignes TVA déductible (une par code TVA distinct)
  for (const [codeKey, { amount, account, rate }] of taxByCode) {
    if (!account) {
      console.warn(
        `[buildJournalEntryPayload] Code TVA "${codeKey}" sans TaxAccount dans VatGroupCache — ligne TVA ${amount.toFixed(2)} € skippée (facture ${invoice.docNumberPa}). Relancer un sync codes TVA SAP.`,
      );
      continue;
    }
    const rateLabel = rate !== null ? `${rate}%` : '';
    const tvaLine: Record<string, unknown> = {
      AccountCode: account,
      Debit: isCreditNote ? 0 : amount,
      Credit: isCreditNote ? amount : 0,
      LineMemo: `TVA ${codeKey}${rateLabel ? ` (${rateLabel})` : ''}`,
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

  // Memo SAP B1 est limité à 50 caractères : on tronque. Si commentaire utilisateur
  // saisi, il remplace le memo par défaut (la référence reste portée par Reference/Reference2).
  const userMemo = invoice.comment?.trim();
  const memo =
    userMemo && userMemo.length > 0
      ? userMemo.slice(0, 50)
      : `${invoice.docNumberPa} — ${invoice.supplierNameRaw}`.slice(0, 50);

  const payload: Record<string, unknown> = {
    Memo: memo,
    Reference: invoice.docNumberPa,
    Reference2: invoice.paMessageId,
    ReferenceDate: toISODate(invoice.docDate),
    DueDate: toISODate(invoice.dueDate ?? invoice.docDate),
    JournalEntryLines: jeLines,
  };
  if (attachmentEntry > 0) payload.AttachmentEntry = attachmentEntry;

  return { payload, skippedLines, balanceWarning };
}
