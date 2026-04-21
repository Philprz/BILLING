/**
 * Enrichisseur : orchestre le matching fournisseur + suggestions de compte,
 * puis met à jour la DB (invoice + invoice_lines + status).
 */

import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { matchSupplier } from './supplier-matcher';
import { findBestRule } from './rule-engine';
import type { RuleInput, LineInput } from './rule-engine';

// ─── Chargement des données de référence ──────────────────────────────────────

async function loadSuppliers() {
  return prisma.supplierCache.findMany({
    select: { cardcode: true, cardname: true, federaltaxid: true, vatregnum: true },
  });
}

async function loadActiveRules(): Promise<RuleInput[]> {
  const rows = await prisma.mappingRule.findMany({
    where: { active: true },
    orderBy: { confidence: 'desc' },
  });

  return rows.map((r) => ({
    id:              r.id,
    scope:           r.scope as 'SUPPLIER' | 'GLOBAL',
    supplierCardcode: r.supplierCardcode,
    matchKeyword:    r.matchKeyword,
    matchTaxRate:    r.matchTaxRate ? Number(r.matchTaxRate) : null,
    matchAmountMin:  r.matchAmountMin ? Number(r.matchAmountMin) : null,
    matchAmountMax:  r.matchAmountMax ? Number(r.matchAmountMax) : null,
    accountCode:     r.accountCode,
    costCenter:      r.costCenter,
    taxCodeB1:       r.taxCodeB1,
    confidence:      r.confidence,
    active:          r.active,
  }));
}

// ─── Enrichissement d'une facture ─────────────────────────────────────────────

export async function enrichInvoice(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!invoice) throw new Error(`Invoice ${invoiceId} introuvable`);

  const [suppliers, rules] = await Promise.all([loadSuppliers(), loadActiveRules()]);

  // ── 1. Matching fournisseur ──────────────────────────────────────────────
  const supplierMatch = matchSupplier(
    invoice.supplierPaIdentifier,
    invoice.supplierNameRaw,
    suppliers,
  );

  const cardcode    = supplierMatch?.cardcode ?? null;
  const matchConf   = supplierMatch?.confidence ?? 0;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      supplierB1Cardcode:      cardcode,
      supplierMatchConfidence: matchConf,
    },
  });

  // ── 2. Suggestions de compte par ligne ──────────────────────────────────
  let allLinesHaveSuggestion = invoice.lines.length > 0;

  for (const line of invoice.lines) {
    const lineInput: LineInput = {
      description:   line.description,
      amountExclTax: Number(line.amountExclTax),
      taxRate:       line.taxRate ? Number(line.taxRate) : null,
    };

    const suggestion = findBestRule(rules, lineInput, cardcode);

    const lineUpdate: Prisma.InvoiceLineUpdateInput = {
      suggestedAccountCode:       suggestion?.accountCode ?? null,
      suggestedAccountConfidence: suggestion?.confidence  ?? 0,
      suggestedCostCenter:        suggestion?.costCenter  ?? null,
      suggestedTaxCodeB1:         suggestion?.taxCodeB1   ?? null,
      suggestionSource:           suggestion?.source      ?? 'Aucune règle applicable',
    };

    await prisma.invoiceLine.update({ where: { id: line.id }, data: lineUpdate });

    if (!suggestion) allLinesHaveSuggestion = false;
  }

  // ── 3. Transition de statut ──────────────────────────────────────────────
  // Ne change pas un statut terminal (POSTED / REJECTED / ERROR)
  const terminal = new Set(['POSTED', 'REJECTED', 'ERROR']);
  if (!terminal.has(invoice.status)) {
    const threshold = matchConf >= 80 && allLinesHaveSuggestion ? 'READY' : 'TO_REVIEW';
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: threshold,
        statusReason: threshold === 'TO_REVIEW'
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
  let errors    = 0;

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
