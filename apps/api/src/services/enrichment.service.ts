/**
 * Re-enrichissement à la demande — API (CDC §8).
 *
 * Réplique la logique pure du worker (supplier-matcher + rule-engine)
 * pour permettre le déclenchement depuis l'API sans dépendance croisée.
 */

import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';

// ─── Supplier matching (réplique de apps/worker/src/matching/supplier-matcher) ─

function normalize(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'SAS',
  'SARL',
  'SA',
  'EURL',
  'SNC',
  'SCI',
  'ET',
  'DE',
  'DU',
  'LA',
  'LE',
  'LES',
  'THE',
]);

function tokenSet(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(' ')
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t)),
  );
}

function tokenOverlap(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const t of sa) {
    if (sb.has(t)) common++;
  }
  return common / Math.max(sa.size, sb.size);
}

interface SupplierCandidate {
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
}

interface SupplierMatchResult {
  cardcode: string;
  confidence: number;
}

function matchSupplier(
  supplierPaIdentifier: string,
  supplierNameRaw: string,
  candidates: SupplierCandidate[],
): SupplierMatchResult | null {
  const idNorm = normalize(supplierPaIdentifier);
  const nameNorm = normalize(supplierNameRaw);
  let best: SupplierMatchResult | null = null;

  for (const c of candidates) {
    let confidence = 0;

    if (c.vatregnum && normalize(c.vatregnum) === idNorm) confidence = 100;
    else if (c.federaltaxid && normalize(c.federaltaxid) === idNorm) confidence = 95;
    else if (normalize(c.cardname) === nameNorm) confidence = 85;
    else if (normalize(c.cardname).includes(nameNorm) || nameNorm.includes(normalize(c.cardname)))
      confidence = 70;
    else {
      const ov = tokenOverlap(c.cardname, supplierNameRaw);
      if (ov >= 0.8) confidence = 60;
    }

    if (confidence > 0 && (!best || confidence > best.confidence)) {
      best = { cardcode: c.cardcode, confidence };
    }
  }
  return best;
}

// ─── Rule engine (réplique de apps/worker/src/matching/rule-engine) ──────────

interface RuleInput {
  id: string;
  scope: 'SUPPLIER' | 'GLOBAL';
  supplierCardcode: string | null;
  matchKeyword: string | null;
  matchTaxRate: number | null;
  matchAmountMin: number | null;
  matchAmountMax: number | null;
  accountCode: string;
  costCenter: string | null;
  taxCodeB1: string | null;
  confidence: number;
  active: boolean;
}

interface LineInput {
  description: string;
  amountExclTax: number;
  taxRate: number | null;
}

interface SuggestionResult {
  accountCode: string;
  costCenter: string | null;
  taxCodeB1: string | null;
  confidence: number;
  source: string;
}

function scoreRule(rule: RuleInput, line: LineInput, cardcode: string | null): number {
  if (!rule.active) return -1;
  let bonus = 0;

  if (rule.scope === 'SUPPLIER') {
    if (!cardcode || rule.supplierCardcode !== cardcode) return -1;
    bonus += 10;
  }
  if (rule.matchKeyword !== null) {
    if (!line.description.toLowerCase().includes(rule.matchKeyword.toLowerCase())) return -1;
    bonus += 5;
  }
  if (rule.matchTaxRate !== null) {
    if (line.taxRate === null || Math.abs(line.taxRate - rule.matchTaxRate) > 0.01) return -1;
    bonus += 5;
  }
  if (rule.matchAmountMin !== null && line.amountExclTax < rule.matchAmountMin) return -1;
  if (rule.matchAmountMax !== null && line.amountExclTax > rule.matchAmountMax) return -1;
  if (rule.matchAmountMin !== null || rule.matchAmountMax !== null) bonus += 5;

  return Math.min(100, rule.confidence + bonus);
}

function criteriaCount(r: RuleInput): number {
  return [r.matchKeyword, r.matchTaxRate, r.matchAmountMin, r.matchAmountMax].filter(
    (v) => v !== null,
  ).length;
}

function findBestRule(
  rules: RuleInput[],
  line: LineInput,
  cardcode: string | null,
): SuggestionResult | null {
  const matched: Array<{ rule: RuleInput; score: number }> = [];
  for (const rule of rules) {
    const score = scoreRule(rule, line, cardcode);
    if (score >= 0) matched.push({ rule, score });
  }
  if (matched.length === 0) return null;

  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const d = criteriaCount(b.rule) - criteriaCount(a.rule);
    if (d !== 0) return d;
    return a.rule.scope === 'SUPPLIER' ? -1 : 1;
  });

  const { rule, score } = matched[0];
  const scopeLabel = rule.scope === 'SUPPLIER' ? `fournisseur ${rule.supplierCardcode}` : 'global';
  return {
    accountCode: rule.accountCode,
    costCenter: rule.costCenter,
    taxCodeB1: rule.taxCodeB1,
    confidence: score,
    source: `Règle ${scopeLabel} — compte ${rule.accountCode} (score ${score}/100)`,
  };
}

// ─── Chargement des références ────────────────────────────────────────────────

async function loadSuppliers(): Promise<SupplierCandidate[]> {
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

// ─── Enrichissement d'une facture ─────────────────────────────────────────────

const AUTO_VALIDATION_THRESHOLD = 80;
const TERMINAL = new Set(['POSTED', 'REJECTED', 'ERROR']);

export async function enrichInvoiceById(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!invoice) throw new Error(`Facture ${invoiceId} introuvable`);
  if (TERMINAL.has(invoice.status)) return; // ne touche pas aux terminaux

  const [suppliers, rules] = await Promise.all([loadSuppliers(), loadActiveRules()]);

  // 1. Matching fournisseur
  const supplierMatch = matchSupplier(
    invoice.supplierPaIdentifier,
    invoice.supplierNameRaw,
    suppliers,
  );
  const cardcode = supplierMatch?.cardcode ?? invoice.supplierB1Cardcode; // conserve si déjà forcé
  const matchConf = supplierMatch?.confidence ?? invoice.supplierMatchConfidence;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { supplierB1Cardcode: cardcode, supplierMatchConfidence: matchConf },
  });

  // 2. Suggestions de compte par ligne
  let allHaveSuggestion = invoice.lines.length > 0;

  for (const line of invoice.lines) {
    const lineInput: LineInput = {
      description: line.description,
      amountExclTax: Number(line.amountExclTax),
      taxRate: line.taxRate ? Number(line.taxRate) : null,
    };

    const suggestion = findBestRule(rules, lineInput, cardcode ?? null);

    const update: Prisma.InvoiceLineUpdateInput = {
      suggestedAccountCode: suggestion?.accountCode ?? null,
      suggestedAccountConfidence: suggestion?.confidence ?? 0,
      suggestedCostCenter: suggestion?.costCenter ?? null,
      suggestedTaxCodeB1: suggestion?.taxCodeB1 ?? null,
      suggestionSource: suggestion?.source ?? 'Aucune règle applicable',
    };
    await prisma.invoiceLine.update({ where: { id: line.id }, data: update });

    if (!suggestion) allHaveSuggestion = false;
  }

  // 3. Transition de statut
  const newStatus: 'READY' | 'TO_REVIEW' =
    (matchConf ?? 0) >= AUTO_VALIDATION_THRESHOLD && allHaveSuggestion ? 'READY' : 'TO_REVIEW';

  const parts: string[] = [];
  if ((matchConf ?? 0) < AUTO_VALIDATION_THRESHOLD)
    parts.push(`fournisseur non résolu (confiance ${matchConf ?? 0}%)`);
  if (!allHaveSuggestion) parts.push('compte non suggéré pour une ou plusieurs lignes');
  if (invoice.lines.length === 0) parts.push('aucune ligne structurée');

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: newStatus,
      statusReason:
        newStatus === 'TO_REVIEW' ? parts.join('; ') || 'révision manuelle requise' : null,
    },
  });
}

// ─── Batch ───────────────────────────────────────────────────────────────────

export async function enrichPendingInvoices(): Promise<{ processed: number; errors: number }> {
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ['NEW', 'TO_REVIEW'] } },
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;

  // Chargement unique des références pour tout le batch
  const [suppliers, rules] = await Promise.all([loadSuppliers(), loadActiveRules()]);

  for (const { id } of invoices) {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!invoice || TERMINAL.has(invoice.status)) continue;

      const cardcode =
        matchSupplier(invoice.supplierPaIdentifier, invoice.supplierNameRaw, suppliers)?.cardcode ??
        invoice.supplierB1Cardcode;
      const matchConf =
        matchSupplier(invoice.supplierPaIdentifier, invoice.supplierNameRaw, suppliers)
          ?.confidence ?? invoice.supplierMatchConfidence;

      await prisma.invoice.update({
        where: { id },
        data: { supplierB1Cardcode: cardcode, supplierMatchConfidence: matchConf },
      });

      let allHave = invoice.lines.length > 0;
      for (const line of invoice.lines) {
        const s = findBestRule(
          rules,
          {
            description: line.description,
            amountExclTax: Number(line.amountExclTax),
            taxRate: line.taxRate ? Number(line.taxRate) : null,
          },
          cardcode ?? null,
        );

        await prisma.invoiceLine.update({
          where: { id: line.id },
          data: {
            suggestedAccountCode: s?.accountCode ?? null,
            suggestedAccountConfidence: s?.confidence ?? 0,
            suggestedCostCenter: s?.costCenter ?? null,
            suggestedTaxCodeB1: s?.taxCodeB1 ?? null,
            suggestionSource: s?.source ?? 'Aucune règle applicable',
          },
        });
        if (!s) allHave = false;
      }

      const newStatus: 'READY' | 'TO_REVIEW' =
        (matchConf ?? 0) >= AUTO_VALIDATION_THRESHOLD && allHave ? 'READY' : 'TO_REVIEW';
      await prisma.invoice.update({
        where: { id },
        data: {
          status: newStatus,
          statusReason: newStatus === 'TO_REVIEW' ? 'révision manuelle requise' : null,
        },
      });
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}
