/**
 * Extraction des lignes de facture depuis le texte brut d'un PDF natif.
 *
 * Problème spécifique à pdf-parse : les cellules d'une même ligne du tableau
 * sont concaténées SANS séparateur, ex. :
 *   "Rames de papier A4 — 5 cartons542.00210.0020%252.00"
 *
 * Stratégie : ancrer sur le `%` (taux de TVA), parser de la fin vers le début
 *   - TTC : montant qui suit le `%`.
 *   - Taux : 1-2 chiffres entiers ou décimaux (5.5%, 2.1%) juste avant `%`.
 *   - HT : calculé par TTC / (1 + taux) puis vérifié comme suffixe — plus
 *     fiable qu'une regex face à des montants concaténés.
 *   - qty + prix unitaire : énumération des diviseurs entiers de HT_cents,
 *     ce qui couvre quantités entières, demi-quantités (0,5) et décimales
 *     jusqu'à 2 chiffres (1,25). On garde la première combinaison dont la
 *     représentation textuelle (qty + unit) termine bien beforeHT.
 *
 * Multi-TVA : chaque ligne porte son propre taux, l'extraction est indépendante
 * d'une ligne à l'autre — un tableau mixant 20 % et 5,5 % est géré nativement.
 */

import type { ParsedLine } from './types';

export interface LineExtractionResult {
  lines: ParsedLine[];
  /** Somme des HT extraits — pour validation croisée avec totalExclTax */
  sumExclTax: number;
  /** 0–100 : confiance globale dans l'extraction des lignes */
  confidence: number;
}

// Un montant décimal "propre" : partie entière soit "0" seul, soit ne
// commençant pas par "0". Sert uniquement à capturer le TTC après `%`.
const NUM = String.raw`(?:0|[1-9]\d{0,6}?)[.,]\d{2}`;

interface RawLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amountExclTax: number;
  taxRate: number;
  amountInclTax: number;
}

function parseDecimal(s: string): number {
  return parseFloat(s.replace(',', '.'));
}

/**
 * Représentation textuelle "minimale" d'un nombre : "42" plutôt que "42.00",
 * "1.5" plutôt que "1.50". Sécurise contre les artefacts flottants en passant
 * par toFixed(2) puis en supprimant les zéros de droite.
 */
function formatMinimal(n: number): string {
  const fixed = n.toFixed(2);
  if (fixed.endsWith('.00')) return fixed.slice(0, -3);
  if (fixed.endsWith('0')) return fixed.slice(0, -1);
  return fixed;
}

/**
 * Variantes textuelles d'un montant (séparateur `.` ou `,`, avec ou sans
 * zéros de droite). Le PDF peut être en français (`,`) ou en anglais (`.`),
 * et un montant entier peut être écrit "42" OU "42.00" selon le template.
 */
function formatVariants(n: number): string[] {
  const set = new Set<string>();
  // Forme 2-décimales (typique des montants monétaires : "42.00", "89,50")
  const two = n.toFixed(2);
  set.add(two);
  set.add(two.replace('.', ','));
  // Forme "minimale" (typique des quantités : "5", "1.5")
  const minimal = formatMinimal(n);
  set.add(minimal);
  if (minimal.includes('.')) set.add(minimal.replace('.', ','));
  return [...set];
}

/**
 * Diviseurs de n inférieurs ou égaux à maxDivisor, triés croissant.
 * Trial division jusqu'à sqrt(n) — rapide même pour n = quelques millions.
 */
function divisorsUpTo(n: number, maxDivisor: number): number[] {
  const divs = new Set<number>();
  for (let i = 1; i * i <= n; i++) {
    if (n % i === 0) {
      if (i <= maxDivisor) divs.add(i);
      const j = n / i;
      if (j <= maxDivisor) divs.add(j);
    }
  }
  return [...divs].sort((a, b) => a - b);
}

/**
 * Tente de parser UNE ligne (forme concaténée sans séparateur).
 * Retourne null si la ligne ne ressemble pas à une ligne de facture.
 */
function tryParseRawLine(raw: string): RawLine | null {
  const trimmed = raw.trim();

  // ── Ancrage sur `%` ────────────────────────────────────────────────────
  const pctIdx = trimmed.lastIndexOf('%');
  if (pctIdx < 0) return null;

  const afterPct = trimmed.slice(pctIdx + 1);
  const ttcMatch = afterPct.match(new RegExp(`^\\s*(${NUM})`));
  if (!ttcMatch) return null;
  const amountInclTax = parseDecimal(ttcMatch[1]);

  // ── Taux : 20, 10, 5.5, 2.1 (accepte point ou virgule) ─────────────────
  // La partie entière ne doit pas commencer par "0" (sauf "0" seul), sinon
  // on capte trop d'octets ("005.5" au lieu de "5.5") et on avale un chiffre
  // de la fin du HT lors du `slice(...).slice(0, -length)` qui suit.
  const beforePct = trimmed.slice(0, pctIdx);
  const rateMatch = beforePct.match(/((?:[1-9]\d?|0)(?:[.,]\d)?)$/);
  if (!rateMatch) return null;
  const taxRate = parseDecimal(rateMatch[1]);
  if (taxRate <= 0 || taxRate > 30) return null;

  const beforeRate = beforePct.slice(0, -rateMatch[1].length);

  // ── HT par calcul + vérification du suffixe ────────────────────────────
  const htRaw = amountInclTax / (1 + taxRate / 100);
  const htCents = Math.round(htRaw * 100);
  const amountExclTax = htCents / 100;
  // Cohérence interne (rare divergence si le taux est exotique)
  if (Math.abs(amountExclTax * (1 + taxRate / 100) - amountInclTax) > 0.05) return null;

  const htStr = amountExclTax.toFixed(2);
  const htStrAlt = htStr.replace('.', ',');
  let htLen: number;
  if (beforeRate.endsWith(htStr)) htLen = htStr.length;
  else if (beforeRate.endsWith(htStrAlt)) htLen = htStrAlt.length;
  else return null;

  const beforeHT = beforeRate.slice(0, -htLen);

  // ── qty + unitPrice par énumération des diviseurs ──────────────────────
  // Invariant : qty (en centièmes) × unit (en centimes) = HT_centimes × 100.
  // On itère donc les diviseurs de (htCents × 100) jusqu'à qty ≤ 9999.99.
  const target = htCents * 100;
  if (target <= 0) return null;
  const maxQtyCents = Math.min(999_999, target); // qty ≤ 9999.99

  for (const qtyCents of divisorsUpTo(target, maxQtyCents)) {
    const qty = qtyCents / 100;
    if (qty < 0.01) continue;
    const unitCents = target / qtyCents;
    const unitPrice = unitCents / 100;
    if (unitPrice < 0.01) continue;
    // Garde-fou flottants : recalcul exact
    if (Math.abs(qty * unitPrice - amountExclTax) > 0.005) continue;

    // Construit toutes les combinaisons textuelles plausibles "qty+unit"
    for (const qStr of formatVariants(qty)) {
      for (const uStr of formatVariants(unitPrice)) {
        const tail = qStr + uStr;
        if (beforeHT.endsWith(tail)) {
          const description = beforeHT.slice(0, -tail.length).trim();
          if (description) {
            return {
              description,
              quantity: qty,
              unitPrice,
              amountExclTax,
              taxRate,
              amountInclTax,
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Extrait toutes les lignes de facture du texte brut.
 * - Localise le bloc tabulaire entre l'en-tête (`Description...TTC`) et le
 *   premier marqueur de fin (`Total HT`, `TVA totale`, bloc "TVA").
 * - Parse chaque ligne candidate ; ignore silencieusement les lignes qui ne
 *   correspondent pas au schéma (ex. lignes blanches, sous-totaux).
 */
export function extractInvoiceLines(rawText: string): LineExtractionResult {
  const text = rawText.replace(/ /g, ' ');

  // En-tête du tableau : doit contenir Description ET (TTC ou Total)
  const headerRe = /Description[\s\S]{0,40}?(TTC|Montant)/i;
  const headerMatch = text.match(headerRe);
  if (!headerMatch) return { lines: [], sumExclTax: 0, confidence: 0 };

  const startIdx = (headerMatch.index ?? 0) + headerMatch[0].length;
  // Fin du bloc : premier marqueur reconnu
  const endRe = /\n\s*(?:TVA(?:\s+totale)?\s*\n|Total\s+HT|TOTAL\s+TTC|Sous-total)/i;
  const afterHeader = text.slice(startIdx);
  const endMatch = afterHeader.match(endRe);
  const block = endMatch ? afterHeader.slice(0, endMatch.index) : afterHeader;

  const candidates = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed: RawLine[] = [];
  for (const candidate of candidates) {
    const line = tryParseRawLine(candidate);
    if (line) parsed.push(line);
  }

  if (parsed.length === 0) return { lines: [], sumExclTax: 0, confidence: 0 };

  const sumExclTax = parsed.reduce((acc, l) => acc + l.amountExclTax, 0);

  const lines: ParsedLine[] = parsed.map((l, idx) => {
    const taxAmount = l.amountInclTax - l.amountExclTax;
    // Quantity en Decimal(19,4) côté Prisma → 4 décimales suffisent
    const qtyDigits = Number.isInteger(l.quantity) ? 0 : 4;
    return {
      lineNo: idx + 1,
      description: l.description,
      quantity: l.quantity.toFixed(qtyDigits),
      unitPrice: l.unitPrice.toFixed(2),
      amountExclTax: l.amountExclTax.toFixed(2),
      taxRate: l.taxRate.toFixed(2),
      taxCode: null,
      taxAmount: taxAmount.toFixed(2),
      amountInclTax: l.amountInclTax.toFixed(2),
    };
  });

  return { lines, sumExclTax, confidence: 90 };
}
