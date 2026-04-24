import { describe, expect, it } from 'vitest';
import {
  scoreRule,
  findBestRule,
  type RuleInput,
  type LineInput,
} from '../../apps/worker/src/matching/rule-engine';

function rule(overrides: Partial<RuleInput> & { id: string }): RuleInput {
  return {
    scope: 'GLOBAL',
    supplierCardcode: null,
    matchKeyword: null,
    matchTaxRate: null,
    matchAmountMin: null,
    matchAmountMax: null,
    accountCode: '601000',
    costCenter: null,
    taxCodeB1: null,
    confidence: 60,
    active: true,
    ...overrides,
  };
}

const line: LineInput = {
  description: 'Prestation de maintenance informatique',
  amountExclTax: 500,
  taxRate: 20,
};

describe('scoreRule', () => {
  it('matches a global rule with no criteria', () => {
    const r = rule({ id: 'r1' });
    const d = scoreRule(r, line, null);
    expect(d.matched).toBe(true);
    expect(d.score).toBe(60);
  });

  it('adds keyword bonus when keyword is present', () => {
    const r = rule({ id: 'r2', matchKeyword: 'maintenance' });
    const d = scoreRule(r, line, null);
    expect(d.matched).toBe(true);
    expect(d.score).toBe(65);
  });

  it('does not match when keyword is absent', () => {
    const r = rule({ id: 'r3', matchKeyword: 'logiciel' });
    const d = scoreRule(r, line, null);
    expect(d.matched).toBe(false);
  });

  it('does not match when tax rate differs', () => {
    const r = rule({ id: 'r4', matchTaxRate: 5.5 });
    const d = scoreRule(r, line, null);
    expect(d.matched).toBe(false);
  });

  it('adds supplier bonus for matching SUPPLIER scope', () => {
    const r = rule({ id: 'r5', scope: 'SUPPLIER', supplierCardcode: 'F001' });
    const d = scoreRule(r, line, 'F001');
    expect(d.matched).toBe(true);
    expect(d.score).toBe(70);
  });

  it('does not match SUPPLIER rule for different supplier', () => {
    const r = rule({ id: 'r6', scope: 'SUPPLIER', supplierCardcode: 'F002' });
    const d = scoreRule(r, line, 'F001');
    expect(d.matched).toBe(false);
  });

  it('caps score at 100', () => {
    const r = rule({
      id: 'r7',
      confidence: 95,
      scope: 'SUPPLIER',
      supplierCardcode: 'F001',
      matchKeyword: 'maintenance',
      matchTaxRate: 20,
    });
    const d = scoreRule(r, line, 'F001');
    expect(d.matched).toBe(true);
    expect(d.score).toBe(100);
  });

  it('does not match inactive rules', () => {
    const r = rule({ id: 'r8', active: false });
    const d = scoreRule(r, line, null);
    expect(d.matched).toBe(false);
  });
});

describe('findBestRule', () => {
  it('returns null when no rules match', () => {
    const r = rule({ id: 'r1', matchKeyword: 'logiciel' });
    expect(findBestRule([r], line, null)).toBeNull();
  });

  it('picks the highest-score rule', () => {
    const low = rule({ id: 'low', confidence: 60 });
    const high = rule({ id: 'high', confidence: 80 });
    const best = findBestRule([low, high], line, null);
    expect(best?.ruleId).toBe('high');
    expect(best?.confidence).toBe(80);
  });

  it('prefers SUPPLIER over GLOBAL at equal score', () => {
    const global = rule({ id: 'gl', confidence: 70 });
    const supplier = rule({
      id: 'sp',
      confidence: 60,
      scope: 'SUPPLIER',
      supplierCardcode: 'F001',
    });
    // supplier.score = 60+10 = 70, tied with global
    const best = findBestRule([global, supplier], line, 'F001');
    expect(best?.ruleId).toBe('sp');
  });

  it('returns account and cost center from the best rule', () => {
    const r = rule({ id: 'r1', accountCode: '615000', costCenter: 'CC-IT', taxCodeB1: 'S1' });
    const best = findBestRule([r], line, null);
    expect(best?.accountCode).toBe('615000');
    expect(best?.costCenter).toBe('CC-IT');
    expect(best?.taxCodeB1).toBe('S1');
  });
});
