/**
 * Enrichisseur : orchestre le matching fournisseur + suggestions de compte,
 * puis met à jour la DB (invoice + invoice_lines + status).
 */

import { prisma } from '@pa-sap-bridge/database';
import { createAuditLogBestEffort } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { matchSupplier } from './supplier-matcher';
import { findBestRule } from './rule-engine';
import type { RuleInput, LineInput } from './rule-engine';

// ─── Chargement des données de référence ──────────────────────────────────────

async function loadSuppliers() {
  return prisma.supplierCache.findMany({
    where: { validFor: true },
    select: {
      cardcode: true,
      cardname: true,
      federaltaxid: true,
      vatregnum: true,
      taxId0: true,
      taxId1: true,
      taxId2: true,
    },
  });
}

async function loadActiveRules(): Promise<RuleInput[]> {
  const rows = await prisma.mappingRule.findMany({
    where: { active: true },
    orderBy: { confidence: 'desc' },
  });

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope as 'SUPPLIER' | 'GLOBAL',
    supplierCardcode: r.supplierCardcode,
    matchKeyword: r.matchKeyword,
    matchTaxRate: r.matchTaxRate ? Number(r.matchTaxRate) : null,
    matchAmountMin: r.matchAmountMin ? Number(r.matchAmountMin) : null,
    matchAmountMax: r.matchAmountMax ? Number(r.matchAmountMax) : null,
    accountCode: r.accountCode,
    costCenter: r.costCenter,
    taxCodeB1: r.taxCodeB1,
    confidence: r.confidence,
    active: r.active,
  }));
}

async function getAutoValidationThreshold(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'AUTO_VALIDATION_THRESHOLD' } });
  return typeof row?.value === 'number' ? row.value : 80;
}

async function getTaxRateMap(): Promise<Record<string, string>> {
  const row = await prisma.setting.findUnique({ where: { key: 'TAX_RATE_MAPPING' } });
  return row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
    ? (row.value as Record<string, string>)
    : {};
}

async function isCachePopulated(): Promise<boolean> {
  try {
    return (await prisma.chartOfAccountCache.count()) > 0;
  } catch {
    return false;
  }
}

async function validateAccount(accountCode: string): Promise<string | null> {
  const account = await prisma.chartOfAccountCache.findUnique({ where: { acctCode: accountCode } });
  if (!account) return 'Compte inexistant dans SAP B1';
  if (!account.activeAccount) return 'Compte inactif dans SAP B1';
  if (!account.postable) return 'Compte non imputable';
  return null;
}

function resolveTaxCode(
  taxRateMap: Record<string, string>,
  taxRate: number | null,
  taxCodeB1: string | null,
): string | null {
  if (taxCodeB1) return taxCodeB1;
  if (taxRate === null) return null;
  return taxRateMap[taxRate.toFixed(2)] ?? null;
}

// ─── Enrichissement d'une facture ─────────────────────────────────────────────

export async function enrichInvoice(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!invoice) throw new Error(`Invoice ${invoiceId} introuvable`);

  const [suppliers, rules, threshold, taxRateMap] = await Promise.all([
    loadSuppliers(),
    loadActiveRules(),
    getAutoValidationThreshold(),
    getTaxRateMap(),
  ]);

  // ── 1. Matching fournisseur ──────────────────────────────────────────────
  const supplierMatch = matchSupplier(
    invoice.supplierPaIdentifier,
    invoice.supplierNameRaw,
    suppliers,
  );

  const cardcode = supplierMatch?.cardcode ?? null;
  const matchConf = supplierMatch?.confidence ?? 0;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      supplierB1Cardcode: cardcode,
      supplierMatchConfidence: matchConf,
      supplierMatchReason: supplierMatch?.matchMethod ?? null,
    },
  });

  // ── 2. Suggestions de compte par ligne ──────────────────────────────────
  // Le cache plan comptable est optionnel : s'il n'est pas synchronisé, on ne le valide pas.
  const cacheReady = await isCachePopulated();
  let allLinesHaveSuggestion = invoice.lines.length > 0;

  for (const line of invoice.lines) {
    const lineInput: LineInput = {
      description: line.description,
      amountExclTax: Number(line.amountExclTax),
      taxRate: line.taxRate ? Number(line.taxRate) : null,
    };

    const rawSuggestion = findBestRule(rules, lineInput, cardcode);
    const invalidReason =
      cacheReady && rawSuggestion ? await validateAccount(rawSuggestion.accountCode) : null;
    const suggestion = invalidReason ? null : rawSuggestion;
    const suggestedTaxCodeB1 = resolveTaxCode(
      taxRateMap,
      lineInput.taxRate,
      suggestion?.taxCodeB1 ?? null,
    );
    const shouldChoose = !!suggestion && !!suggestedTaxCodeB1 && suggestion.confidence >= threshold;
    const sourceText = invalidReason
      ? `${rawSuggestion?.source ?? 'Suggestion'} — ${invalidReason}`
      : (suggestion?.source ?? 'Aucune règle applicable');

    const lineUpdate: Prisma.InvoiceLineUpdateInput = {
      suggestedAccountCode: suggestion?.accountCode ?? null,
      suggestedAccountConfidence: suggestion?.confidence ?? 0,
      suggestedCostCenter: suggestion?.costCenter ?? null,
      suggestedTaxCodeB1,
      suggestionSource: sourceText,
      chosenAccountCode: shouldChoose ? suggestion.accountCode : null,
      chosenCostCenter: shouldChoose ? suggestion.costCenter : null,
      chosenTaxCodeB1: shouldChoose ? suggestedTaxCodeB1 : null,
    };

    await prisma.invoiceLine.update({ where: { id: line.id }, data: lineUpdate });
    await createAuditLogBestEffort({
      action: 'EDIT_MAPPING',
      entityType: 'INVOICE',
      entityId: invoiceId,
      outcome: suggestion ? 'OK' : 'ERROR',
      payloadAfter: {
        stage: 'ACCOUNT_SUGGESTION',
        invoiceId,
        lineId: line.id,
        lineNo: line.lineNo,
        description: line.description,
        accountCode: suggestion?.accountCode ?? null,
        confidence: suggestion?.confidence ?? 0,
        matchedRuleId: suggestion?.ruleId ?? null,
        fallback: null,
        reason: sourceText,
      },
    });

    if (!suggestion) allLinesHaveSuggestion = false;
  }

  // ── 3. Transition de statut ──────────────────────────────────────────────
  // Ne change pas un statut terminal (POSTED / REJECTED / ERROR)
  const terminal = new Set(['POSTED', 'REJECTED', 'ERROR']);
  if (!terminal.has(invoice.status)) {
    const refreshedLines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
    const allChosen =
      refreshedLines.length > 0 &&
      refreshedLines.every((l) => !!l.chosenAccountCode && !!l.chosenTaxCodeB1);
    const nextStatus = matchConf >= threshold && allChosen ? 'READY' : 'TO_REVIEW';
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: nextStatus,
        statusReason:
          nextStatus === 'TO_REVIEW'
            ? buildReviewReason(matchConf, allLinesHaveSuggestion, invoice.lines.length)
            : null,
      },
    });
  }
}

function buildReviewReason(
  matchConf: number,
  allLinesHaveSuggestion: boolean,
  lineCount: number,
): string {
  const parts: string[] = [];
  if (matchConf < 80) parts.push(`fournisseur non résolu (confiance ${matchConf}%)`);
  if (!allLinesHaveSuggestion) parts.push('compte non suggéré pour une ou plusieurs lignes');
  if (lineCount === 0) parts.push('aucune ligne structurée');
  return parts.join('; ') || 'révision manuelle requise';
}

// ─── Re-enrichissement batch ──────────────────────────────────────────────────

export async function enrichPendingInvoices(): Promise<{ processed: number; errors: number }> {
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ['NEW', 'TO_REVIEW'] } },
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;

  for (const { id } of invoices) {
    try {
      await enrichInvoice(id);
      processed++;
    } catch (err) {
      console.error(`[Enricher] Erreur sur ${id}: ${String(err)}`);
      errors++;
    }
  }

  return { processed, errors };
}
