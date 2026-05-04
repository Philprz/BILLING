import { describe, it, expect } from 'vitest';
import {
  findBestRule,
  scoreRule,
  type RuleInput,
  type LineInput,
} from '../../apps/api/src/services/enrichment.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rule(overrides: Partial<RuleInput> & { accountCode: string }): RuleInput {
  return {
    id: 'test-rule',
    scope: 'GLOBAL',
    supplierCardcode: null,
    matchKeyword: null,
    matchTaxRate: null,
    matchAmountMin: null,
    matchAmountMax: null,
    costCenter: null,
    taxCodeB1: null,
    confidence: 70,
    active: true,
    ...overrides,
  };
}

function line(overrides: Partial<LineInput> & { description: string }): LineInput {
  return {
    amountExclTax: 100,
    taxRate: 20,
    ...overrides,
  };
}

// ─── Règles énergie (issues du seed) ─────────────────────────────────────────

const ENERGY_RULES: RuleInput[] = [
  rule({ matchKeyword: 'électricité', accountCode: '606200', confidence: 75 }),
  rule({ matchKeyword: 'electricite', accountCode: '606200', confidence: 72 }),
  rule({ matchKeyword: 'énergie', accountCode: '606200', confidence: 72 }),
  rule({ matchKeyword: 'energie', accountCode: '606200', confidence: 70 }),
  rule({ matchKeyword: 'acheminement', accountCode: '606200', confidence: 70 }),
  rule({ matchKeyword: 'puissance', accountCode: '606200', confidence: 68 }),
  rule({ matchKeyword: 'maintenance', accountCode: '615000', taxCodeB1: 'S1', confidence: 72 }),
  rule({ matchKeyword: 'entretien', accountCode: '615000', taxCodeB1: 'S1', confidence: 70 }),
  rule({ matchKeyword: 'hébergement', accountCode: '626300', taxCodeB1: 'S1', confidence: 70 }),
  rule({ matchKeyword: 'cloud', accountCode: '618500', taxCodeB1: 'S1', confidence: 68 }),
  rule({ matchKeyword: 'serveur', accountCode: '618500', taxCodeB1: 'S1', confidence: 65 }),
  rule({ matchKeyword: 'fournitures', accountCode: '606100', taxCodeB1: 'S1', confidence: 70 }),
  rule({ matchKeyword: 'consommable', accountCode: '606100', taxCodeB1: 'S1', confidence: 68 }),
  rule({ matchTaxRate: 20, accountCode: '606000', confidence: 40 }),
];

// ─── Tests : cas électricité ──────────────────────────────────────────────────

describe('findBestRule — énergie / électricité', () => {
  it('ligne "Consommation électricité site" → compte 606200', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Consommation électricité site' }),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.accountCode).toBe('606200');
    expect(result!.confidence).toBeGreaterThanOrEqual(75);
  });

  it('ligne "Abonnement puissance" → compte 606200', () => {
    const result = findBestRule(ENERGY_RULES, line({ description: 'Abonnement puissance' }), null);
    expect(result).not.toBeNull();
    expect(result!.accountCode).toBe('606200');
  });

  it('ligne "Contribution acheminement réseau" → compte 606200', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Contribution acheminement réseau' }),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.accountCode).toBe('606200');
  });

  it('ligne avec "énergie" (accent) → compte 606200', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Fourniture énergie électrique' }),
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.accountCode).toBe('606200');
  });

  it('source contient le compte et le score', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Consommation électricité site' }),
      null,
    );
    expect(result!.source).toMatch(/606200/);
    expect(result!.source).toMatch(/score \d+\/100/);
  });
});

// ─── Tests : autres catégories ────────────────────────────────────────────────

describe('findBestRule — autres catégories', () => {
  it('ligne "Maintenance préventive" → compte 615000', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Maintenance préventive' }),
      null,
    );
    expect(result!.accountCode).toBe('615000');
  });

  it('ligne "Hébergement serveurs web" → compte 626300 (hébergement > serveur)', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Hébergement serveurs web' }),
      null,
    );
    expect(result!.accountCode).toBe('626300');
  });

  it('ligne "Fournitures de bureau" → compte 606100', () => {
    const result = findBestRule(ENERGY_RULES, line({ description: 'Fournitures de bureau' }), null);
    expect(result!.accountCode).toBe('606100');
  });

  it('ligne inconnue avec TVA 20% → filet de sécurité 606000 (score faible)', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Divers non catégorisé', taxRate: 20 }),
      null,
    );
    expect(result!.accountCode).toBe('606000');
    expect(result!.confidence).toBeLessThan(60);
  });

  it('ligne sans TVA ni mot-clé connu → null', () => {
    const result = findBestRule(
      ENERGY_RULES,
      line({ description: 'Divers non catégorisé', taxRate: null }),
      null,
    );
    expect(result).toBeNull();
  });
});

// ─── Tests : règle fournisseur prioritaire ────────────────────────────────────

describe('findBestRule — scope SUPPLIER prioritaire', () => {
  const supplierRule = rule({
    id: 'supplier-rule',
    scope: 'SUPPLIER',
    supplierCardcode: 'F_ELEC01',
    matchKeyword: 'électricité',
    accountCode: '606250',
    confidence: 85,
  });
  const allRules = [...ENERGY_RULES, supplierRule];

  it('ligne "Consommation électricité site" + cardcode F_ELEC01 → règle fournisseur 606250', () => {
    const result = findBestRule(
      allRules,
      line({ description: 'Consommation électricité site' }),
      'F_ELEC01',
    );
    expect(result!.accountCode).toBe('606250');
  });

  it('même ligne + cardcode différent → règle globale 606200', () => {
    const result = findBestRule(
      allRules,
      line({ description: 'Consommation électricité site' }),
      'F_OTHER',
    );
    expect(result!.accountCode).toBe('606200');
  });
});

// ─── Tests : statut facture selon les suggestions ─────────────────────────────

describe('statut facture — logique READY vs TO_REVIEW', () => {
  it('toutes les lignes mappées → allHaveSuggestion = true', () => {
    const lines: LineInput[] = [
      { description: 'Consommation électricité site', amountExclTax: 150, taxRate: 20 },
      { description: 'Abonnement puissance', amountExclTax: 45, taxRate: 20 },
      { description: 'Contribution acheminement réseau', amountExclTax: 30, taxRate: 20 },
    ];
    const allHave = lines.every((l) => findBestRule(ENERGY_RULES, l, null) !== null);
    expect(allHave).toBe(true);
  });

  it('une ligne sans compte → allHaveSuggestion = false', () => {
    const lines: LineInput[] = [
      { description: 'Consommation électricité site', amountExclTax: 150, taxRate: 20 },
      { description: 'Prestation inconnue XYZ', amountExclTax: 200, taxRate: null },
    ];
    const allHave = lines.every((l) => findBestRule(ENERGY_RULES, l, null) !== null);
    expect(allHave).toBe(false);
  });
});

// ─── Tests : scoreRule ────────────────────────────────────────────────────────

describe('scoreRule', () => {
  it('règle inactive → score -1', () => {
    const r = rule({ matchKeyword: 'électricité', accountCode: '606200', active: false });
    expect(scoreRule(r, line({ description: 'électricité' }), null)).toBe(-1);
  });

  it('règle SUPPLIER sans cardcode fourni → -1', () => {
    const r = rule({
      scope: 'SUPPLIER',
      supplierCardcode: 'F_ELEC01',
      matchKeyword: 'électricité',
      accountCode: '606200',
    });
    expect(scoreRule(r, line({ description: 'électricité' }), null)).toBe(-1);
  });

  it('règle keyword non trouvé dans description → -1', () => {
    const r = rule({ matchKeyword: 'électricité', accountCode: '606200', confidence: 70 });
    expect(scoreRule(r, line({ description: 'Maintenance équipements' }), null)).toBe(-1);
  });

  it('bonus keyword appliqué', () => {
    const r = rule({ matchKeyword: 'électricité', accountCode: '606200', confidence: 70 });
    // 70 + 5 (keyword bonus) = 75
    expect(scoreRule(r, line({ description: 'électricité' }), null)).toBe(75);
  });

  it('bonus SUPPLIER + keyword appliqués', () => {
    const r = rule({
      scope: 'SUPPLIER',
      supplierCardcode: 'F_ELEC01',
      matchKeyword: 'électricité',
      accountCode: '606200',
      confidence: 70,
    });
    // 70 + 10 (supplier) + 5 (keyword) = 85
    expect(scoreRule(r, line({ description: 'électricité' }), 'F_ELEC01')).toBe(85);
  });
});
