/**
 * Moteur de suggestion de compte comptable — logique pure, sans accès DB.
 *
 * Priorité des règles :
 *   - Une règle ne MATCH que si TOUS ses critères non-null sont satisfaits.
 *   - Score final = rule.confidence + bonus de spécificité (plafonné à 100).
 *
 * Bonus de spécificité :
 *   +10  scope = SUPPLIER
 *   + 5  matchKeyword renseigné et présent dans la description
 *   + 5  matchTaxRate renseigné et exact
 *   + 5  matchAmountMin ou matchAmountMax renseigné et satisfait
 *
 * En cas d'égalité de score : SUPPLIER > GLOBAL, puis plus de critères.
 */

export interface RuleInput {
  id:              string;
  scope:           'SUPPLIER' | 'GLOBAL';
  supplierCardcode: string | null;
  matchKeyword:    string | null;
  matchTaxRate:    number | null;   // ex. 20.00
  matchAmountMin:  number | null;
  matchAmountMax:  number | null;
  accountCode:     string;
  costCenter:      string | null;
  taxCodeB1:       string | null;
  confidence:      number;          // confiance de base 0-100
  active:          boolean;
}

export interface LineInput {
  description:   string;
  amountExclTax: number;
  taxRate:       number | null;
}

export interface SuggestionResult {
  accountCode:  string;
  costCenter:   string | null;
  taxCodeB1:    string | null;
  confidence:   number;   // score final 0-100
  source:       string;   // explication lisible
  ruleId:       string;
}

export interface ScoreDetail {
  ruleId:      string;
  matched:     boolean;
  score:       number;
  breakdown:   string[];  // liste des critères qui ont contribué
}

// ─── Évaluation d'une règle ───────────────────────────────────────────────────

export function scoreRule(rule: RuleInput, line: LineInput, supplierCardcode: string | null): ScoreDetail {
  if (!rule.active) {
    return { ruleId: rule.id, matched: false, score: 0, breakdown: ['règle inactive'] };
  }

  const breakdown: string[] = [];
  let bonus = 0;

  // Critère scope/fournisseur
  if (rule.scope === 'SUPPLIER') {
    if (!supplierCardcode || rule.supplierCardcode !== supplierCardcode) {
      return { ruleId: rule.id, matched: false, score: 0, breakdown: [`fournisseur ${rule.supplierCardcode} ≠ ${supplierCardcode}`] };
    }
    bonus += 10;
    breakdown.push(`fournisseur ${rule.supplierCardcode} (+10)`);
  }

  // Critère mot-clé
  if (rule.matchKeyword !== null) {
    const kw = rule.matchKeyword.toLowerCase();
    if (!line.description.toLowerCase().includes(kw)) {
      return { ruleId: rule.id, matched: false, score: 0, breakdown: [`mot-clé '${rule.matchKeyword}' absent`] };
    }
    bonus += 5;
    breakdown.push(`mot-clé '${rule.matchKeyword}' (+5)`);
  }

  // Critère taux de TVA
  if (rule.matchTaxRate !== null) {
    if (line.taxRate === null || Math.abs(line.taxRate - rule.matchTaxRate) > 0.01) {
      return { ruleId: rule.id, matched: false, score: 0, breakdown: [`taux TVA ${rule.matchTaxRate}% ≠ ${line.taxRate}`] };
    }
    bonus += 5;
    breakdown.push(`taux TVA ${rule.matchTaxRate}% (+5)`);
  }

  // Critère montant minimum
  if (rule.matchAmountMin !== null) {
    if (line.amountExclTax < rule.matchAmountMin) {
      return { ruleId: rule.id, matched: false, score: 0, breakdown: [`montant ${line.amountExclTax} < min ${rule.matchAmountMin}`] };
    }
    bonus += 5;
    breakdown.push(`montant ≥ ${rule.matchAmountMin} (+5)`);
  }

  // Critère montant maximum
  if (rule.matchAmountMax !== null) {
    if (line.amountExclTax > rule.matchAmountMax) {
      return { ruleId: rule.id, matched: false, score: 0, breakdown: [`montant ${line.amountExclTax} > max ${rule.matchAmountMax}`] };
    }
    bonus += 5;
    breakdown.push(`montant ≤ ${rule.matchAmountMax} (+5)`);
  }

  const score = Math.min(100, rule.confidence + bonus);
  breakdown.unshift(`confiance base ${rule.confidence}`);
  return { ruleId: rule.id, matched: true, score, breakdown };
}

// ─── Sélection de la meilleure règle ─────────────────────────────────────────

function criteriaCount(rule: RuleInput): number {
  return [rule.matchKeyword, rule.matchTaxRate, rule.matchAmountMin, rule.matchAmountMax]
    .filter((v) => v !== null).length;
}

export function findBestRule(
  rules:            RuleInput[],
  line:             LineInput,
  supplierCardcode: string | null,
): (SuggestionResult & { scoreDetail: ScoreDetail }) | null {

  const candidates: Array<{ rule: RuleInput; detail: ScoreDetail }> = [];

  for (const rule of rules) {
    const detail = scoreRule(rule, line, supplierCardcode);
    if (detail.matched) candidates.push({ rule, detail });
  }

  if (candidates.length === 0) return null;

  // Tri :
  //   1. Score décroissant
  //   2. À score égal : plus de critères (plus spécifique) gagne
  //   3. À score et critères égaux : SUPPLIER avant GLOBAL
  candidates.sort((a, b) => {
    if (b.detail.score !== a.detail.score) return b.detail.score - a.detail.score;
    const critDiff = criteriaCount(b.rule) - criteriaCount(a.rule);
    if (critDiff !== 0) return critDiff;
    if (a.rule.scope !== b.rule.scope) return a.rule.scope === 'SUPPLIER' ? -1 : 1;
    return 0;
  });

  const { rule, detail } = candidates[0];

  const scopeLabel = rule.scope === 'SUPPLIER'
    ? `fournisseur ${rule.supplierCardcode}`
    : 'global';
  const criteriaLabel = detail.breakdown.slice(1).join(', ') || 'aucun critère supplémentaire';
  const source = `Règle ${scopeLabel} — ${criteriaLabel} — compte ${rule.accountCode} (score ${detail.score}/100)`;

  return {
    accountCode: rule.accountCode,
    costCenter:  rule.costCenter,
    taxCodeB1:   rule.taxCodeB1,
    confidence:  detail.score,
    source,
    ruleId:      rule.id,
    scoreDetail: detail,
  };
}
