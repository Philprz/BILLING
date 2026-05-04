/**
 * Matching fournisseur — logique pure, sans accès DB.
 *
 * Priorité :
 *   1. SIRET/SIREN exact (tax_id0/federaltaxid)     → confidence 100
 *   2. TVA intracommunautaire exacte                → confidence 98
 *   3. CardCode exact                               → confidence 95
 *   4. Nom normalisé exact                          → confidence 85
 *   5. Fuzzy nom, seulement sans identifiant fiable  → confidence 60-70
 */

export interface SupplierCandidate {
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  taxId0?: string | null;
  tax_id0?: string | null;
  taxId1?: string | null;
  tax_id1?: string | null;
  taxId2?: string | null;
  tax_id2?: string | null;
}

export interface SupplierMatchResult {
  cardcode: string;
  cardname: string;
  confidence: number; // 0–100
  matchMethod: string; // explication lisible
  ambiguous?: boolean;
  candidates?: Array<{
    cardcode: string;
    cardname: string;
    confidence: number;
    matchMethod: string;
  }>;
}

// ─── Normalisation ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les accents
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeId(s: string): string {
  return normalize(s).replace(/\s/g, '');
}

function digits(s: string): string {
  return s.replace(/\D/g, '');
}

function isVat(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{8,14}$/.test(normalizeId(value));
}

function reliableLegalIds(value: string): string[] {
  const d = digits(value);
  return [d.length === 9 || d.length === 14 ? d : null].filter((v): v is string => Boolean(v));
}

function tokenSet(s: string): Set<string> {
  // Mots ignorés (formes juridiques, articles)
  const STOP = new Set([
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
  return new Set(
    normalize(s)
      .split(' ')
      .filter((t) => t.length > 1 && !STOP.has(t)),
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

// ─── Matching ────────────────────────────────────────────────────────────────

export function matchSupplier(
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
    let matchMethod = '';
    const candidateLegalIds = [
      c.taxId0 ?? c.tax_id0 ?? null,
      c.taxId1 ?? c.tax_id1 ?? null,
      c.taxId2 ?? c.tax_id2 ?? null,
      c.federaltaxid,
    ].flatMap((v) => (v ? reliableLegalIds(v) : []));

    // 1. SIRET/SIREN exact
    if (legalIds.length > 0 && candidateLegalIds.some((id) => legalIds.includes(id))) {
      confidence = 100;
      matchMethod = `SIRET/SIREN exact`;
    }
    // 2. TVA exacte
    else if (vatId && [c.vatregnum, c.federaltaxid].some((v) => v && normalizeId(v) === vatId)) {
      confidence = 98;
      matchMethod = `TVA exacte`;
    }
    // 3. CardCode exact
    else if (idNorm && normalizeId(c.cardcode) === idNorm) {
      confidence = 95;
      matchMethod = 'CardCode exact';
    }
    // 4. Nom normalisé exact
    else if (normalize(c.cardname) === nameNorm) {
      confidence = 85;
      matchMethod = `Nom exact`;
    }
    // 5. Fuzzy nom uniquement si l'identifiant PA n'est pas fiscalement fiable
    else if (
      !vatId &&
      legalIds.length === 0 &&
      (normalize(c.cardname).includes(nameNorm) || nameNorm.includes(normalize(c.cardname)))
    ) {
      confidence = 70;
      matchMethod = `Nom inclus dans l'autre`;
    } else if (!vatId && legalIds.length === 0) {
      const overlap = tokenOverlap(c.cardname, supplierNameRaw);
      if (overlap >= 0.8) {
        confidence = 60;
        matchMethod = `Recouvrement tokens ${Math.round(overlap * 100)}%`;
      }
    }

    if (confidence > 0) {
      scored.push({ cardcode: c.cardcode, cardname: c.cardname, confidence, matchMethod });
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.confidence - a.confidence || a.cardcode.localeCompare(b.cardcode));
  const best = scored[0];
  const close = scored.filter((s) => best.confidence - s.confidence <= 5);
  if (close.length > 1) {
    return {
      ...best,
      confidence: Math.min(best.confidence, 79),
      ambiguous: true,
      matchMethod: `Ambiguïté fournisseur (${close.length} candidats proches)`,
      candidates: close.map((s) => ({
        cardcode: s.cardcode,
        cardname: s.cardname,
        confidence: s.confidence,
        matchMethod: s.matchMethod,
      })),
    };
  }
  return best;
}
