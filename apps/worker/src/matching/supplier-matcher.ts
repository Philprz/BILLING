/**
 * Matching fournisseur — logique pure, sans accès DB.
 *
 * Priorité :
 *   1. TVA intracommunautaire exacte (vatregnum)   → confidence 100
 *   2. Numéro fiscal exact (federaltaxid)           → confidence 95
 *   3. Nom normalisé exact                          → confidence 85
 *   4. Nom normalisé contenu dans l'autre sens      → confidence 70
 *   5. Recouvrement de tokens > 80 %               → confidence 60
 */

export interface SupplierCandidate {
  cardcode:    string;
  cardname:    string;
  federaltaxid: string | null;
  vatregnum:   string | null;
}

export interface SupplierMatchResult {
  cardcode:    string;
  cardname:    string;
  confidence:  number;   // 0–100
  matchMethod: string;   // explication lisible
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // retire les accents
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s: string): Set<string> {
  // Mots ignorés (formes juridiques, articles)
  const STOP = new Set(['SAS', 'SARL', 'SA', 'EURL', 'SNC', 'SCI', 'ET', 'DE', 'DU', 'LA', 'LE', 'LES', 'THE']);
  return new Set(normalize(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t)));
}

function tokenOverlap(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const t of sa) { if (sb.has(t)) common++; }
  return common / Math.max(sa.size, sb.size);
}

// ─── Matching ────────────────────────────────────────────────────────────────

export function matchSupplier(
  supplierPaIdentifier: string,
  supplierNameRaw:      string,
  candidates:           SupplierCandidate[],
): SupplierMatchResult | null {

  const idNorm  = normalize(supplierPaIdentifier);
  const nameNorm = normalize(supplierNameRaw);
  let best: SupplierMatchResult | null = null;

  for (const c of candidates) {
    let confidence  = 0;
    let matchMethod = '';

    // 1. TVA exacte
    if (c.vatregnum && normalize(c.vatregnum) === idNorm) {
      confidence  = 100;
      matchMethod = `TVA exacte (${c.vatregnum})`;
    }
    // 2. Identifiant fiscal exact
    else if (c.federaltaxid && normalize(c.federaltaxid) === idNorm) {
      confidence  = 95;
      matchMethod = `Identifiant fiscal exact (${c.federaltaxid})`;
    }
    // 3. Nom normalisé exact
    else if (normalize(c.cardname) === nameNorm) {
      confidence  = 85;
      matchMethod = `Nom exact`;
    }
    // 4. Nom contenu
    else if (normalize(c.cardname).includes(nameNorm) || nameNorm.includes(normalize(c.cardname))) {
      confidence  = 70;
      matchMethod = `Nom inclus dans l'autre`;
    }
    // 5. Recouvrement de tokens
    else {
      const overlap = tokenOverlap(c.cardname, supplierNameRaw);
      if (overlap >= 0.8) {
        confidence  = 60;
        matchMethod = `Recouvrement tokens ${Math.round(overlap * 100)}%`;
      }
    }

    if (confidence > 0 && (!best || confidence > best.confidence)) {
      best = { cardcode: c.cardcode, cardname: c.cardname, confidence, matchMethod };
    }
  }

  return best;
}
