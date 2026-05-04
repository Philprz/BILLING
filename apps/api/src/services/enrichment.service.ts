/**
 * Re-enrichissement à la demande — API (CDC §8).
 *
 * Réplique la logique pure du worker (supplier-matcher + rule-engine)
 * pour permettre le déclenchement depuis l'API sans dépendance croisée.
 */

import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { createAuditLogBestEffort } from '@pa-sap-bridge/database';
import {
  validateCachedAccount,
  isCachePopulated,
  findClosestAccounts,
  searchCachedAccounts,
} from './chart-of-accounts-cache.service';
import { resolveTaxCode } from './tax-code-resolver.service';

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
  taxId0?: string | null;
  taxId1?: string | null;
  taxId2?: string | null;
}

interface SupplierMatchResult {
  cardcode: string;
  confidence: number;
  reason: string;
  ambiguous?: boolean;
  candidates?: Array<{ cardcode: string; cardname: string; confidence: number; reason: string }>;
}

function normalizeId(s: string): string {
  return normalize(s).replace(/\s/g, '');
}

function digits(s: string): string {
  return s.replace(/\D/g, '');
}

function reliableLegalIds(value: string): string[] {
  const d = digits(value);
  return d.length === 9 || d.length === 14 ? [d] : [];
}

function isVat(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{8,14}$/.test(normalizeId(value));
}

function matchSupplier(
  supplierPaIdentifier: string,
  supplierNameRaw: string,
  candidates: SupplierCandidate[],
): SupplierMatchResult | null {
  const idNorm = normalizeId(supplierPaIdentifier);
  const nameNorm = normalize(supplierNameRaw);
  const legalIds = reliableLegalIds(supplierPaIdentifier);
  const vatId = isVat(supplierPaIdentifier) ? idNorm : null;
  const scored: SupplierMatchResult[] = [];

  for (const c of candidates) {
    let confidence = 0;
    let reason = '';
    const candidateLegalIds = [c.taxId0, c.taxId1, c.taxId2, c.federaltaxid].flatMap((v) =>
      v ? reliableLegalIds(v) : [],
    );

    if (legalIds.length > 0 && candidateLegalIds.some((id) => legalIds.includes(id))) {
      confidence = 100;
      reason = 'SIRET/SIREN exact';
    } else if (vatId && [c.vatregnum, c.federaltaxid].some((v) => v && normalizeId(v) === vatId)) {
      confidence = 98;
      reason = 'TVA exacte';
    } else if (idNorm && normalizeId(c.cardcode) === idNorm) {
      confidence = 95;
      reason = 'CardCode exact';
    } else if (normalize(c.cardname) === nameNorm) {
      confidence = 85;
      reason = 'Nom exact';
    } else if (
      !vatId &&
      legalIds.length === 0 &&
      (normalize(c.cardname).includes(nameNorm) || nameNorm.includes(normalize(c.cardname)))
    ) {
      confidence = 70;
      reason = "Nom inclus dans l'autre";
    } else if (!vatId && legalIds.length === 0) {
      const ov = tokenOverlap(c.cardname, supplierNameRaw);
      if (ov >= 0.8) {
        confidence = 60;
        reason = `Recouvrement tokens ${Math.round(ov * 100)}%`;
      }
    }

    if (confidence > 0) scored.push({ cardcode: c.cardcode, confidence, reason });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.confidence - a.confidence || a.cardcode.localeCompare(b.cardcode));
  const best = scored[0];
  const close = scored.filter((s) => best.confidence - s.confidence <= 5);
  if (close.length > 1) {
    return {
      ...best,
      confidence: Math.min(best.confidence, 79),
      reason: `Ambiguïté fournisseur (${close.length} candidats proches)`,
      ambiguous: true,
      candidates: close.map((s) => ({
        cardcode: s.cardcode,
        cardname: candidates.find((c) => c.cardcode === s.cardcode)?.cardname ?? s.cardcode,
        confidence: s.confidence,
        reason: s.reason,
      })),
    };
  }
  return best;
}

// ─── Rule engine (réplique de apps/worker/src/matching/rule-engine) ──────────

export interface RuleInput {
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

export interface LineInput {
  description: string;
  amountExclTax: number;
  taxRate: number | null;
}

export interface SuggestionResult {
  accountCode: string;
  costCenter: string | null;
  taxCodeB1: string | null;
  confidence: number;
  source: string;
  ruleId: string | null;
}

export function scoreRule(rule: RuleInput, line: LineInput, cardcode: string | null): number {
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

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findBestRule(
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
    ruleId: rule.id,
  };
}

const FALLBACK_CATEGORIES: Array<{
  key: string;
  settingKey: string;
  label: string;
  keywords: string[];
}> = [
  {
    key: 'energy',
    settingKey: 'DEFAULT_ENERGY_ACCOUNT_CODE',
    label: 'énergie / électricité',
    keywords: [
      'electricite',
      'energie',
      'consommation electrique',
      'abonnement puissance',
      'acheminement',
    ],
  },
  {
    key: 'maintenance',
    settingKey: 'DEFAULT_MAINTENANCE_ACCOUNT_CODE',
    label: 'maintenance / entretien',
    keywords: ['maintenance', 'entretien'],
  },
  {
    key: 'hosting',
    settingKey: 'DEFAULT_HOSTING_ACCOUNT_CODE',
    label: 'hébergement / serveur / cloud',
    keywords: ['hebergement', 'serveur', 'cloud'],
  },
  {
    key: 'supplies',
    settingKey: 'DEFAULT_SUPPLIES_ACCOUNT_CODE',
    label: 'fournitures / consommables / papeterie',
    keywords: [
      'fournitures',
      'consommables',
      'papeterie',
      'bureau',
      'papier',
      'ramette',
      'classeur',
      'stylo',
      'bille',
      'feutre',
      'marqueur',
      'toner',
      'cartouche',
      'encre',
      'imprimante',
      'impression',
      'cahier',
      'enveloppe',
      'chemise',
      'pochette',
      'agrafeuse',
      'scotch',
    ],
  },
  {
    key: 'it_equipment',
    settingKey: 'DEFAULT_IT_ACCOUNT_CODE',
    label: 'matériel informatique',
    keywords: [
      'informatique',
      'ordinateur',
      'portable',
      'tablette',
      'ecran',
      'moniteur',
      'clavier',
      'souris',
      'disque',
      'memoire',
      'processeur',
      'peripherique',
      'scanner',
      'imprimante',
      'routeur',
      'switch',
      'reseau',
    ],
  },
  {
    key: 'telecom',
    settingKey: 'DEFAULT_TELECOM_ACCOUNT_CODE',
    label: 'téléphonie / télécommunications',
    keywords: [
      'telephone',
      'mobile',
      'abonnement',
      'telephonie',
      'telecommunication',
      'internet',
      'forfait',
    ],
  },
  {
    key: 'transport',
    settingKey: 'DEFAULT_TRANSPORT_ACCOUNT_CODE',
    label: 'transport / livraison',
    keywords: [
      'transport',
      'livraison',
      'expedition',
      'fret',
      'messagerie',
      'colissimo',
      'fedex',
      'dhl',
    ],
  },
];

async function getSettingString(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return typeof row?.value === 'string' && row.value.trim() ? row.value.trim() : null;
}

async function findFallbackSuggestion(line: LineInput): Promise<SuggestionResult | null> {
  const description = normalizeText(line.description);
  const category = FALLBACK_CATEGORIES.find((candidate) =>
    candidate.keywords.some((kw) => description.includes(normalizeText(kw))),
  );
  if (!category) return null;

  const accountCode = await getSettingString(category.settingKey);
  if (!accountCode) {
    return {
      accountCode: 'TO_REVIEW',
      costCenter: null,
      taxCodeB1: null,
      confidence: 20,
      source: `Fallback ${category.label} détecté, mais ${category.settingKey} n'est pas configuré`,
      ruleId: null,
    };
  }

  return {
    accountCode,
    costCenter: null,
    taxCodeB1: null,
    confidence: 70,
    source: `Fallback configurable ${category.label} via ${category.settingKey} (score 70/100)`,
    ruleId: null,
  };
}

// ─── Recherche par description dans le plan comptable local ──────────────────

const FRENCH_STOP_WORDS = new Set([
  'les',
  'des',
  'une',
  'par',
  'sur',
  'sous',
  'avec',
  'pour',
  'dans',
  'sans',
  'que',
  'qui',
  'aux',
  'est',
  'pas',
  'tout',
  'cette',
  'comme',
  'plus',
]);

// Traduction produit → termes comptables : les noms de produits ne se trouvent jamais
// dans les intitulés de comptes SAP. Cette table fait le lien entre les deux.
const PRODUCT_TO_ACCOUNTING_TERMS: Array<{ products: string[]; terms: string[] }> = [
  {
    products: [
      'papier',
      'ramette',
      'classeur',
      'stylo',
      'bille',
      'feutre',
      'marqueur',
      'cahier',
      'enveloppe',
      'chemise',
      'pochette',
      'agrafeuse',
      'scotch',
      'trombone',
      'papeterie',
      'toner',
      'cartouche',
      'encre',
      'consommable',
    ],
    terms: ['fournitures', 'bureau', 'papeterie', 'consommables'],
  },
  {
    products: ['imprimante', 'scanner', 'photocopie', 'copieur', 'multifonction'],
    terms: ['fournitures', 'informatique', 'materiel', 'bureautique'],
  },
  {
    products: [
      'ordinateur',
      'portable',
      'tablette',
      'ecran',
      'moniteur',
      'clavier',
      'souris',
      'disque',
      'memoire',
      'processeur',
      'peripherique',
      'informatique',
      'serveur',
    ],
    terms: ['informatique', 'materiel', 'equipement'],
  },
  {
    products: ['telephone', 'mobile', 'telephonie', 'forfait', 'abonnement', 'internet'],
    terms: ['telephone', 'telecommunication', 'communication'],
  },
  {
    products: ['transport', 'livraison', 'expedition', 'fret', 'messagerie'],
    terms: ['transport', 'expedition', 'livraison'],
  },
  {
    products: ['formation', 'stage', 'seminaire', 'conference'],
    terms: ['formation', 'personnel'],
  },
  {
    products: ['electricite', 'gaz', 'eau', 'energie', 'chauffage'],
    terms: ['energie', 'electricite', 'fluides'],
  },
];

async function findCacheBasedSuggestion(line: LineInput): Promise<SuggestionResult | null> {
  const words = normalizeText(line.description)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !FRENCH_STOP_WORDS.has(w));

  if (words.length === 0) return null;

  // 1ère tentative : recherche directe par mots de la description
  for (const word of words.slice(0, 4)) {
    const accounts = await searchCachedAccounts(word);
    if (accounts.length > 0) {
      return {
        accountCode: accounts[0].acctCode,
        costCenter: null,
        taxCodeB1: null,
        confidence: 85,
        source: `Correspondance description "${word}" → ${accounts[0].acctCode} ${accounts[0].acctName}`,
        ruleId: null,
      };
    }
  }

  // 2ème tentative : traduction produit → termes comptables (ex: "papier" → "fournitures")
  for (const mapping of PRODUCT_TO_ACCOUNTING_TERMS) {
    const matched = words.find((w) => mapping.products.includes(w));
    if (matched) {
      for (const term of mapping.terms) {
        const accounts = await searchCachedAccounts(term);
        if (accounts.length > 0) {
          return {
            accountCode: accounts[0].acctCode,
            costCenter: null,
            taxCodeB1: null,
            confidence: 85,
            source: `Correspondance "${matched}" → catégorie "${term}" → ${accounts[0].acctCode} ${accounts[0].acctName}`,
            ruleId: null,
          };
        }
      }
    }
  }

  return null;
}

// ─── Chargement des références ────────────────────────────────────────────────

async function loadSuppliers(): Promise<SupplierCandidate[]> {
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

// ─── Enrichissement d'une facture ─────────────────────────────────────────────

const DEFAULT_AUTO_VALIDATION_THRESHOLD = 80;
const TERMINAL = new Set(['POSTED', 'REJECTED']);

async function getAutoValidationThreshold(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'AUTO_VALIDATION_THRESHOLD' } });
  return typeof row?.value === 'number' ? row.value : DEFAULT_AUTO_VALIDATION_THRESHOLD;
}

export async function enrichInvoiceById(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true },
  });
  if (!invoice) throw new Error(`Facture ${invoiceId} introuvable`);
  if (TERMINAL.has(invoice.status)) return; // ne touche pas aux terminaux

  const [suppliers, rules, autoValidationThreshold] = await Promise.all([
    loadSuppliers(),
    loadActiveRules(),
    getAutoValidationThreshold(),
  ]);

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
    data: {
      supplierB1Cardcode: cardcode,
      supplierMatchConfidence: matchConf,
      supplierMatchReason: supplierMatch?.reason ?? null,
      ...(supplierMatch?.ambiguous
        ? {
            status: 'TO_REVIEW',
            statusReason: supplierMatch.reason,
          }
        : {}),
    },
  });

  // 2. Suggestions de compte par ligne
  // Le cache plan comptable est optionnel : s'il n'est pas encore synchronisé, on ne l'utilise pas.
  const cacheReady = await isCachePopulated();
  let allHaveSuggestion = invoice.lines.length > 0;

  for (const line of invoice.lines) {
    const lineInput: LineInput = {
      description: line.description,
      amountExclTax: Number(line.amountExclTax),
      taxRate: line.taxRate ? Number(line.taxRate) : null,
    };

    // Étape 1 : règle ou catégorie par mots-clés configurés
    let rawSuggestion =
      findBestRule(rules, lineInput, cardcode ?? null) ?? (await findFallbackSuggestion(lineInput));

    // Étape 2 : validation du compte suggéré dans le cache local
    let accountValidation = null;
    if (cacheReady && rawSuggestion && rawSuggestion.accountCode !== 'TO_REVIEW') {
      accountValidation = await validateCachedAccount(rawSuggestion.accountCode);
    }

    // Étape 3 : si aucune suggestion valide, recherche par mots-clés de la description dans le plan comptable
    if (cacheReady && (!rawSuggestion || (accountValidation && !accountValidation.ok))) {
      const descFallback = await findCacheBasedSuggestion(lineInput);
      if (descFallback) {
        rawSuggestion = descFallback;
        accountValidation = null; // searchCachedAccounts garantit activeAccount + postable
      }
    }

    // Compte toujours invalide après tentative de fallback : on conserve l'erreur avec suggestion de proche
    let invalidReason: string | null = null;
    if (rawSuggestion && accountValidation && !accountValidation.ok) {
      const closest = await findClosestAccounts(rawSuggestion.accountCode, 2);
      const hint =
        closest.length > 0
          ? ` — Compte le plus proche : ${closest.map((a) => `${a.acctCode} (${a.acctName})`).join(', ')}`
          : '';
      invalidReason = `${rawSuggestion.source} — ${accountValidation.reason} : ${rawSuggestion.accountCode}${hint}`;
    }

    // Cache absent : suggestion conservée mais jamais auto-appliquée
    const suggestion =
      rawSuggestion && (!accountValidation || accountValidation.ok) ? rawSuggestion : null;
    const taxResolution =
      suggestion && cacheReady
        ? await resolveTaxCode({
            supplierCardCode: cardcode ?? null,
            accountCode: suggestion.accountCode,
            taxRate: lineInput.taxRate,
          })
        : null;
    const suggestedTaxCodeB1 = taxResolution?.taxCode ?? null;

    // Le compte est appliqué dès que la confiance est suffisante et que le cache est prêt.
    // Le code TVA n'est PAS requis pour appliquer le compte — il sera à compléter si absent.
    // Respect du verrou compte posé manuellement par l'utilisateur
    const keepAccount =
      (line as { accountCodeLockedByUser?: boolean }).accountCodeLockedByUser ?? false;
    const shouldChooseAccount =
      !keepAccount &&
      cacheReady &&
      !!suggestion &&
      suggestion.confidence >= autoValidationThreshold;
    // Respect du verrou TVA posé manuellement par l'utilisateur
    const keepTaxCode = line.taxCodeLockedByUser;
    const shouldChooseTaxCode = shouldChooseAccount && !!suggestedTaxCodeB1 && !keepTaxCode;

    const sourceText =
      invalidReason ??
      (!cacheReady && rawSuggestion
        ? `${rawSuggestion.source} — ⚠ Plan comptable non synchronisé, compte non vérifié`
        : null) ??
      rawSuggestion?.source ??
      'Aucune règle applicable';
    const update: Prisma.InvoiceLineUpdateInput = {
      suggestedAccountCode: suggestion?.accountCode ?? null,
      suggestedAccountConfidence: suggestion?.confidence ?? 0,
      suggestedCostCenter: suggestion?.costCenter ?? null,
      suggestedTaxCodeB1,
      suggestionSource: sourceText,
      // Ne pas écraser si compte verrouillé manuellement
      ...(keepAccount
        ? {}
        : { chosenAccountCode: shouldChooseAccount ? suggestion.accountCode : null }),
      ...(keepAccount
        ? {}
        : { chosenCostCenter: shouldChooseAccount ? suggestion.costCenter : null }),
      chosenTaxCodeB1: keepTaxCode
        ? line.chosenTaxCodeB1 // ne pas écraser le choix manuel
        : shouldChooseTaxCode
          ? suggestedTaxCodeB1
          : null,
      ...(shouldChooseAccount && !keepTaxCode ? { taxCodeLockedByUser: false } : {}),
    };
    await prisma.invoiceLine.update({ where: { id: line.id }, data: update });

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
        fallback: suggestion?.ruleId ? null : (suggestion?.source ?? rawSuggestion?.source ?? null),
        reason: sourceText,
      },
    });

    if (!suggestion) allHaveSuggestion = false;
  }

  // 3. Transition de statut
  const refreshedLines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const allHaveChosenAccountAndTax =
    refreshedLines.length > 0 &&
    refreshedLines.every((l) => !!l.chosenAccountCode && !!l.chosenTaxCodeB1);
  const newStatus: 'READY' | 'TO_REVIEW' =
    (matchConf ?? 0) >= autoValidationThreshold && allHaveChosenAccountAndTax
      ? 'READY'
      : 'TO_REVIEW';

  const parts: string[] = [];
  if ((matchConf ?? 0) < autoValidationThreshold)
    parts.push(`fournisseur non résolu (confiance ${matchConf ?? 0}%)`);
  if (!allHaveSuggestion) parts.push('compte non suggéré pour une ou plusieurs lignes');
  if (!allHaveChosenAccountAndTax)
    parts.push('compte choisi ou code TVA B1 manquant sur une ou plusieurs lignes');
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

  for (const { id } of invoices) {
    try {
      await enrichInvoiceById(id);
      processed++;
    } catch {
      errors++;
    }
  }

  return { processed, errors };
}
