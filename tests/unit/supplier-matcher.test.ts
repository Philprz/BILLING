import { describe, expect, it } from 'vitest';
import {
  matchSupplier,
  type SupplierCandidate,
} from '../../apps/worker/src/matching/supplier-matcher';

function candidate(
  overrides: Partial<SupplierCandidate> & { cardcode: string; cardname: string },
): SupplierCandidate {
  return { federaltaxid: null, vatregnum: null, ...overrides };
}

const candidates: SupplierCandidate[] = [
  candidate({
    cardcode: 'F001',
    cardname: 'Alpha Services SARL',
    vatregnum: 'FR12345678901',
    federaltaxid: '12345678901234',
  }),
  candidate({ cardcode: 'F002', cardname: 'Beta Consulting SAS' }),
  candidate({ cardcode: 'F003', cardname: 'Gamma Tech', vatregnum: 'FR99887766554' }),
];

describe('matchSupplier', () => {
  it('returns null when no candidates', () => {
    expect(matchSupplier('FR00000000000', 'Unknown', [])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchSupplier('FR00000000000', 'Zzz Corp', candidates)).toBeNull();
  });

  // ── Priority 1 — TVA exacte (confidence 100) ─────────────────────────────

  it('matches by exact VAT number with confidence 100', () => {
    const result = matchSupplier('FR12345678901', 'N importe quoi', candidates);
    expect(result).not.toBeNull();
    expect(result!.cardcode).toBe('F001');
    expect(result!.confidence).toBe(100);
    expect(result!.matchMethod).toContain('TVA exacte');
  });

  it('VAT match is case-insensitive after normalization', () => {
    const result = matchSupplier('fr12345678901', 'N importe quoi', candidates);
    expect(result?.cardcode).toBe('F001');
    expect(result?.confidence).toBe(100);
  });

  // ── Priority 2 — identifiant fiscal (confidence 95) ──────────────────────

  it('matches by federal tax id with confidence 95 when VAT does not match', () => {
    const result = matchSupplier('12345678901234', 'N importe quoi', candidates);
    expect(result?.cardcode).toBe('F001');
    expect(result?.confidence).toBe(95);
    expect(result!.matchMethod).toContain('fiscal');
  });

  // ── Priority 3 — nom exact normalisé (confidence 85) ─────────────────────

  it('matches by exact normalized name with confidence 85', () => {
    const result = matchSupplier('UNKNOWN', 'Beta Consulting SAS', candidates);
    expect(result?.cardcode).toBe('F002');
    expect(result?.confidence).toBe(85);
  });

  it('name match ignores accents', () => {
    const local = [candidate({ cardcode: 'F010', cardname: 'Étoile Médias' })];
    const result = matchSupplier('UNKNOWN', 'Etoile Medias', local);
    expect(result?.cardcode).toBe('F010');
    expect(result?.confidence).toBe(85);
  });

  // ── Priority 4 — nom inclus (confidence 70) ──────────────────────────────

  it('matches when name is contained within candidate name (confidence 70)', () => {
    const local = [candidate({ cardcode: 'F020', cardname: 'Grande Entreprise Alpha Services' })];
    const result = matchSupplier('UNKNOWN', 'Alpha Services', local);
    expect(result?.cardcode).toBe('F020');
    expect(result?.confidence).toBe(70);
  });

  it('matches when candidate name is contained within supplier name (confidence 70)', () => {
    const local = [candidate({ cardcode: 'F021', cardname: 'TechCorp' })];
    const result = matchSupplier('UNKNOWN', 'TechCorp Solutions France', local);
    expect(result?.cardcode).toBe('F021');
    expect(result?.confidence).toBe(70);
  });

  // ── Priority 5 — token overlap >= 80% (confidence 60) ───────────────────

  it('matches by high token overlap with confidence 60', () => {
    const local = [candidate({ cardcode: 'F030', cardname: 'Prestation Informatique Nord' })];
    // tokens: PRESTATION INFORMATIQUE NORD → 3 tokens
    // supplier: PRESTATION INFORMATIQUE SUD → overlap 2/3 = 67% → no match
    // supplier: NORD PRESTATION INFORMATIQUE → overlap 3/3 = 100% → match
    const result = matchSupplier('UNKNOWN', 'Nord Prestation Informatique', local);
    expect(result?.cardcode).toBe('F030');
    expect(result?.confidence).toBe(60);
  });

  it('does not match when token overlap is below 80%', () => {
    const local = [
      candidate({ cardcode: 'F031', cardname: 'Prestation Informatique Nord France Conseil' }),
    ];
    // supplier: "Delta Corp" → very low overlap
    const result = matchSupplier('UNKNOWN', 'Delta Corp', local);
    expect(result).toBeNull();
  });

  // ── Best candidate selection ──────────────────────────────────────────────

  it('returns the highest confidence match among multiple candidates', () => {
    const local: SupplierCandidate[] = [
      candidate({ cardcode: 'LOW', cardname: 'Alpha Services SARL' }), // confidence 85 (exact name)
      candidate({ cardcode: 'HIGH', cardname: 'anything', vatregnum: 'FR12345678901' }), // confidence 100 (VAT)
    ];
    const result = matchSupplier('FR12345678901', 'Alpha Services SARL', local);
    expect(result?.cardcode).toBe('HIGH');
    expect(result?.confidence).toBe(100);
  });

  // ── Stop words are stripped from token matching ───────────────────────────

  it('ignores legal form tokens (SAS, SARL, etc.) in token overlap', () => {
    const local = [candidate({ cardcode: 'F040', cardname: 'Dupont Services SARL' })];
    // Normalized names differ ("DUPONT SERVICES SARL" vs "DUPONT SERVICES SAS")
    // but after stop-word stripping both token sets are {DUPONT, SERVICES} → 100% overlap
    const result = matchSupplier('UNKNOWN', 'Dupont Services SAS', local);
    expect(result?.cardcode).toBe('F040');
    expect(result?.confidence).toBe(60); // token overlap, not exact name
    expect(result?.matchMethod).toContain('100%');
  });
});
