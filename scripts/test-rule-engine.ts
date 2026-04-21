/**
 * Tests unitaires — moteur de règles + matching fournisseur
 * Pure functions, aucun accès DB.
 *
 * Usage : npm run test:matching
 */

import { scoreRule, findBestRule } from '../apps/worker/src/matching/rule-engine';
import { matchSupplier } from '../apps/worker/src/matching/supplier-matcher';
import type { RuleInput, LineInput } from '../apps/worker/src/matching/rule-engine';
import type { SupplierCandidate } from '../apps/worker/src/matching/supplier-matcher';

// ─── Mini framework de test ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     → ${(e as Error).message}`);
    failed++;
  }
}

function expect<T>(val: T) {
  return {
    toBe: (expected: T) => {
      if (val !== expected) throw new Error(`Attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(val)}`);
    },
    toBeNull: () => {
      if (val !== null) throw new Error(`Attendu null, reçu ${JSON.stringify(val)}`);
    },
    toBeGreaterThan: (n: number) => {
      if ((val as number) <= n) throw new Error(`Attendu > ${n}, reçu ${val}`);
    },
    toBeGreaterThanOrEqual: (n: number) => {
      if ((val as number) < n) throw new Error(`Attendu >= ${n}, reçu ${val}`);
    },
    toBeLessThanOrEqual: (n: number) => {
      if ((val as number) > n) throw new Error(`Attendu <= ${n}, reçu ${val}`);
    },
    not: {
      toBeNull: () => {
        if (val === null || val === undefined) throw new Error(`Attendu non-null, reçu null/undefined`);
      },
    },
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_RULE: RuleInput = {
  id: 'r1', scope: 'GLOBAL',
  supplierCardcode: null, matchKeyword: null,
  matchTaxRate: null, matchAmountMin: null, matchAmountMax: null,
  accountCode: '606000', costCenter: null, taxCodeB1: null,
  confidence: 50, active: true,
};

const LINE_PAPIER: LineInput = { description: 'Papier A4 ramette 500 feuilles x100', amountExclTax: 850, taxRate: 20 };
const LINE_LOGICIEL: LineInput = { description: 'Licence logiciel annuelle', amountExclTax: 4800, taxRate: 20 };
const LINE_FORMATION: LineInput = { description: 'Formation utilisateurs (2 jours)', amountExclTax: 1000, taxRate: 20 };
const LINE_CONSEIL: LineInput = { description: 'Prestation conseil informatique', amountExclTax: 400, taxRate: 20 };
const LINE_FOURNITURES: LineInput = { description: 'Fournitures de bureau — pack premium', amountExclTax: 600, taxRate: 20 };
const LINE_AVOIR: LineInput = { description: 'Avoir — retour marchandises défectueuses', amountExclTax: -320, taxRate: 20 };

const SUPPLIERS: SupplierCandidate[] = [
  { cardcode: 'F_ACME01',   cardname: 'ACME Fournitures SAS',   federaltaxid: '12345678901234', vatregnum: 'FR12345678901' },
  { cardcode: 'F_BUREAU01', cardname: 'Bureau Direct SAS',       federaltaxid: '11223344556789', vatregnum: 'FR11223344556' },
  { cardcode: 'F_TECHSOL',  cardname: 'Tech Solutions SARL',     federaltaxid: '98765432109876', vatregnum: 'FR98765432109' },
];

// ─── Tests : scoreRule ────────────────────────────────────────────────────────

console.log('\n── scoreRule ──');

test('Règle inactive → non matchée', () => {
  const r = { ...BASE_RULE, active: false };
  const d = scoreRule(r, LINE_PAPIER, null);
  expect(d.matched).toBe(false);
});

test('Règle GLOBAL sans critères → match, score = confidence', () => {
  const r = { ...BASE_RULE, confidence: 50 };
  const d = scoreRule(r, LINE_PAPIER, null);
  expect(d.matched).toBe(true);
  expect(d.score).toBe(50);
});

test('Règle GLOBAL + mot-clé présent → +5 bonus', () => {
  const r = { ...BASE_RULE, matchKeyword: 'papier', confidence: 70 };
  const d = scoreRule(r, LINE_PAPIER, null);
  expect(d.matched).toBe(true);
  expect(d.score).toBe(75);
});

test('Règle GLOBAL + mot-clé absent → non matchée', () => {
  const r = { ...BASE_RULE, matchKeyword: 'logiciel', confidence: 70 };
  const d = scoreRule(r, LINE_PAPIER, null);
  expect(d.matched).toBe(false);
});

test('Règle SUPPLIER + bon fournisseur → +10 bonus', () => {
  const r = { ...BASE_RULE, scope: 'SUPPLIER' as const, supplierCardcode: 'F_ACME01', confidence: 60 };
  const d = scoreRule(r, LINE_PAPIER, 'F_ACME01');
  expect(d.matched).toBe(true);
  expect(d.score).toBe(70);
});

test('Règle SUPPLIER + mauvais fournisseur → non matchée', () => {
  const r = { ...BASE_RULE, scope: 'SUPPLIER' as const, supplierCardcode: 'F_ACME01', confidence: 60 };
  const d = scoreRule(r, LINE_PAPIER, 'F_BUREAU01');
  expect(d.matched).toBe(false);
});

test('Règle SUPPLIER + mot-clé + TVA → +10 +5 +5 = 20 bonus', () => {
  const r = { ...BASE_RULE, scope: 'SUPPLIER' as const, supplierCardcode: 'F_ACME01', matchKeyword: 'papier', matchTaxRate: 20, confidence: 70 };
  const d = scoreRule(r, LINE_PAPIER, 'F_ACME01');
  expect(d.matched).toBe(true);
  expect(d.score).toBe(90);
});

test('Score plafonné à 100', () => {
  const r = { ...BASE_RULE, scope: 'SUPPLIER' as const, supplierCardcode: 'F_ACME01', matchKeyword: 'papier', matchTaxRate: 20, confidence: 85 };
  const d = scoreRule(r, LINE_PAPIER, 'F_ACME01');
  expect(d.score).toBe(100);
});

test('matchAmountMin non satisfait → non matchée', () => {
  const r = { ...BASE_RULE, matchAmountMin: 1000, confidence: 60 };
  const d = scoreRule(r, LINE_PAPIER, null);  // amountExclTax = 850 < 1000
  expect(d.matched).toBe(false);
});

test('matchAmountMin satisfait → +5 bonus', () => {
  const r = { ...BASE_RULE, matchAmountMin: 500, confidence: 60 };
  const d = scoreRule(r, LINE_PAPIER, null);  // amountExclTax = 850 >= 500
  expect(d.matched).toBe(true);
  expect(d.score).toBe(65);
});

test('matchAmountMax non satisfait → non matchée', () => {
  const r = { ...BASE_RULE, matchAmountMax: 500, confidence: 60 };
  const d = scoreRule(r, LINE_LOGICIEL, null);  // amountExclTax = 4800 > 500
  expect(d.matched).toBe(false);
});

// ─── Tests : findBestRule ─────────────────────────────────────────────────────

console.log('\n── findBestRule ──');

const RULE_SET: RuleInput[] = [
  { ...BASE_RULE, id: 'g-papier',  matchKeyword: 'papier',    accountCode: '606100', confidence: 70 },
  { ...BASE_RULE, id: 'g-fourni',  matchKeyword: 'fournitures', accountCode: '606100', confidence: 70 },
  { ...BASE_RULE, id: 'g-logiciel',matchKeyword: 'logiciel',   accountCode: '618500', confidence: 75 },
  { ...BASE_RULE, id: 'g-form',    matchKeyword: 'formation',  accountCode: '618000', confidence: 75 },
  { ...BASE_RULE, id: 'g-conseil', matchKeyword: 'conseil',    accountCode: '622700', confidence: 70 },
  { ...BASE_RULE, id: 'g-avoir',   matchKeyword: 'avoir',      accountCode: '609000', confidence: 70 },
  { ...BASE_RULE, id: 'g-tva20',   matchTaxRate: 20,           accountCode: '606000', confidence: 40 },
  // Règles fournisseur F_ACME01
  { ...BASE_RULE, id: 's-papier',  scope: 'SUPPLIER', supplierCardcode: 'F_ACME01', matchKeyword: 'papier',    accountCode: '606100', taxCodeB1: 'S1', confidence: 85 },
  { ...BASE_RULE, id: 's-fourni',  scope: 'SUPPLIER', supplierCardcode: 'F_ACME01', matchKeyword: 'fournitures', accountCode: '606100', taxCodeB1: 'S1', confidence: 78 },
  { ...BASE_RULE, id: 's-catch',   scope: 'SUPPLIER', supplierCardcode: 'F_ACME01', accountCode: '606000', confidence: 60 },
];

test('Aucune règle → null', () => {
  const r = findBestRule([], LINE_PAPIER, 'F_ACME01');
  expect(r).toBeNull();
});

test('"Papier A4..." + F_ACME01 → règle supplier papier (s-papier, score 100)', () => {
  const r = findBestRule(RULE_SET, LINE_PAPIER, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('s-papier');
  expect(r!.accountCode).toBe('606100');
  expect(r!.taxCodeB1).toBe('S1');
  expect(r!.confidence).toBe(100);   // 85 + supplier(10) + keyword(5) = 100
});

test('"Licence logiciel..." + F_ACME01 → règle global logiciel (g-logiciel, score 80)', () => {
  // F_ACME01 n'a pas de règle logiciel → global wins
  const r = findBestRule(RULE_SET, LINE_LOGICIEL, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('g-logiciel');
  expect(r!.accountCode).toBe('618500');
  expect(r!.confidence).toBe(80);    // 75 + keyword(5)
});

test('"Formation..." + F_ACME01 → règle global formation (g-form, score 80)', () => {
  const r = findBestRule(RULE_SET, LINE_FORMATION, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('g-form');
  expect(r!.accountCode).toBe('618000');
  expect(r!.confidence).toBe(80);
});

test('"Fournitures de bureau..." + F_ACME01 → règle supplier fournitures (s-fourni, score 93)', () => {
  // s-fourni: 78 + supplier(10) + keyword(5) = 93
  // g-fourni: 70 + keyword(5) = 75
  // s-catch: 60 + supplier(10) = 70
  const r = findBestRule(RULE_SET, LINE_FOURNITURES, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('s-fourni');
  expect(r!.confidence).toBe(93);
});

test('"Prestation conseil..." + F_ACME01 → règle global conseil (g-conseil, score 75)', () => {
  // g-conseil: 70 + keyword(5) = 75
  // s-catch: 60 + supplier(10) = 70
  const r = findBestRule(RULE_SET, LINE_CONSEIL, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('g-conseil');
  expect(r!.confidence).toBe(75);
});

test('"Avoir — retour..." sans fournisseur → règle global avoir (g-avoir, score 75)', () => {
  const r = findBestRule(RULE_SET, LINE_AVOIR, null);
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('g-avoir');
  expect(r!.confidence).toBe(75);  // 70 + keyword(5)
});

test('Score égal : plus de critères (GLOBAL+keyword) bat SUPPLIER sans critère', () => {
  // glob: GLOBAL + keyword 'test' → score 80+5=85, criteriaCount=1
  // supp: SUPPLIER                → score 75+10=85, criteriaCount=0
  // À score égal, plus de critères gagne → glob doit l'emporter
  const rules: RuleInput[] = [
    { ...BASE_RULE, id: 'glob', scope: 'GLOBAL', matchKeyword: 'test', confidence: 80 },
    { ...BASE_RULE, id: 'supp', scope: 'SUPPLIER', supplierCardcode: 'F_ACME01', confidence: 75 },
  ];
  const line: LineInput = { description: 'test article', amountExclTax: 100, taxRate: 20 };
  const r = findBestRule(rules, line, 'F_ACME01');
  expect(r).not.toBeNull();
  expect(r!.ruleId).toBe('glob');
});

test('Conflit : même score, SUPPLIER gagne sur GLOBAL sans critères', () => {
  const rules: RuleInput[] = [
    { ...BASE_RULE, id: 'glob', scope: 'GLOBAL', confidence: 85 },   // score 85, 0 critères
    { ...BASE_RULE, id: 'supp', scope: 'SUPPLIER', supplierCardcode: 'F_ACME01', confidence: 75 }, // score 85, 0 critères
  ];
  const line: LineInput = { description: 'article quelconque', amountExclTax: 100, taxRate: 20 };
  const r = findBestRule(rules, line, 'F_ACME01');
  expect(r!.ruleId).toBe('supp');  // score égal → SUPPLIER gagne
});

// ─── Tests : matchSupplier ────────────────────────────────────────────────────

console.log('\n── matchSupplier ──');

test('TVA exacte → confidence 100', () => {
  const r = matchSupplier('FR12345678901', 'ACME Fournitures SAS', SUPPLIERS);
  expect(r).not.toBeNull();
  expect(r!.cardcode).toBe('F_ACME01');
  expect(r!.confidence).toBe(100);
  expect(r!.matchMethod.startsWith('TVA exacte')).toBe(true);
});

test('Identifiant fiscal → confidence 95', () => {
  const r = matchSupplier('11223344556789', 'Bureau Direct SAS', SUPPLIERS);
  expect(r).not.toBeNull();
  expect(r!.cardcode).toBe('F_BUREAU01');
  expect(r!.confidence).toBe(95);
});

test('Nom exactement normalisé → confidence 85', () => {
  const r = matchSupplier('UNKNOWN_ID', 'Tech Solutions SARL', SUPPLIERS);
  expect(r).not.toBeNull();
  expect(r!.cardcode).toBe('F_TECHSOL');
  expect(r!.confidence).toBe(85);
});

test('Identifiant inconnu + nom sans match → null', () => {
  const r = matchSupplier('FRXXXXXXXX', 'Fournisseur Inconnu SA', SUPPLIERS);
  expect(r).toBeNull();
});

test('Nom inclus → confidence 70', () => {
  // "ACME Fournitures" est inclus dans "ACME Fournitures SAS"
  const r = matchSupplier('FRINCONNU', 'Acme Fournitures', SUPPLIERS);
  expect(r).not.toBeNull();
  expect(r!.cardcode).toBe('F_ACME01');
  expect(r!.confidence).toBe(70);
});

test('TVA prioritaire sur nom exact', () => {
  // Deux candidats : l'un match par TVA (F_ACME01), l'autre par nom exact
  const candidates: SupplierCandidate[] = [
    { cardcode: 'F_DUMMY', cardname: 'Test Fournisseur', federaltaxid: null, vatregnum: null },
    { cardcode: 'F_ACME01', cardname: 'ACME Fournitures SAS', federaltaxid: null, vatregnum: 'FR12345678901' },
  ];
  const r = matchSupplier('FR12345678901', 'Test Fournisseur', candidates);
  expect(r!.cardcode).toBe('F_ACME01');
  expect(r!.confidence).toBe(100);
});

// ─── Récapitulatif ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Résultat : ${passed} ✅ passés  |  ${failed} ❌ échoués`);
if (failed > 0) {
  console.error('ÉCHEC — des tests ont échoué');
  process.exit(1);
} else {
  console.log('OK — tous les tests passent');
}
