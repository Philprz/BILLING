/**
 * Extraction par regex/heuristique des champs d'une facture depuis le texte
 * brut d'un PDF natif. Vise les factures fournisseur françaises (Lot 11+).
 *
 * Champs visés :
 *   - supplierPaIdentifier : SIRET (14 chiffres) > TVA intracom (FR + 11) > ''
 *   - supplierNameRaw      : 1re ligne non vide après "FOURNISSEUR"
 *   - documentNumber       : "Facture / Numéro : XXX"
 *   - documentDate         : YYYY-MM-DD (formats FR et ISO acceptés)
 *   - dueDate              : "Date d'échéance"
 *   - currency             : ISO 4217 trouvée dans le texte (EUR par défaut)
 *   - totalExclTax / totalTax / totalInclTax
 *
 * Aucun champ n'est inventé : si une regex échoue, le champ est laissé vide
 * et sa confiance retombe à 0. L'appelant décide ce qu'il en fait.
 */

export interface PdfExtractedFields {
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  documentNumber: string;
  documentDate: string | null;
  dueDate: string | null;
  currency: string;
  totalExclTax: string;
  totalTax: string;
  totalInclTax: string;
  /** 0–100 par champ, pour traçabilité audit */
  confidence: {
    supplier: number;
    documentNumber: number;
    documentDate: number;
    totals: number;
  };
}

function num(s: string): string {
  // "1 234,56" → "1234.56" ; "210.00" → "210.00"
  return s
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
}

function toIsoDate(raw: string): string | null {
  // Accepte YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  return null;
}

/**
 * Délimite le bloc FOURNISSEUR pour scoper les recherches d'identifiants
 * fiscaux. Commence à la ligne "FOURNISSEUR" (seule, pas le titre "FACTURE
 * FOURNISSEUR") et se termine au prochain en-tête de section : ACHETEUR,
 * FACTURE seul, ou en-tête du tableau ("Description"). On NE s'arrête PAS
 * sur SIRET/TVA — ce sont précisément les lignes qu'on cherche à capturer.
 */
function extractSupplierBlock(text: string): string {
  const m = text.match(
    /(?:^|\n)FOURNISSEUR\s*\n([\s\S]*?)(?=\n\s*(?:ACHETEUR\b|FACTURE\s*\n|Description\b)|$)/i,
  );
  return m?.[1] ?? '';
}

function findFirstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

export function extractInvoiceFields(rawText: string): PdfExtractedFields {
  const text = rawText.replace(/\u00A0/g, ' '); // NBSP → espace normal

  // ── Bloc FOURNISSEUR (scope des identifiants fiscaux et du nom) ────────
  // Sans ce scope, le SIRET de l'ACHETEUR — souvent présent dans la même
  // page — remonterait dès que le fournisseur n'a qu'un n° TVA.
  const supplierBlock = extractSupplierBlock(text);

  // ── Identifiants fiscaux (cherchés UNIQUEMENT dans le bloc fournisseur) ─
  const siret = supplierBlock.match(/\bSIRET\s*[:\s]\s*(\d{3}\s?\d{3}\s?\d{3}\s?\d{5})\b/i)?.[1];
  const siretClean = siret?.replace(/\s/g, '');
  const tva = supplierBlock.match(/\b(FR\s?\d{2}\s?\d{9})\b/i)?.[1]?.replace(/\s/g, '');

  // ── Nom fournisseur (1re ligne non vide du bloc) ───────────────────────
  let supplierName = '';
  if (supplierBlock) {
    const lines = supplierBlock
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    supplierName = lines[0] ?? '';
  }

  // ── Numéro de facture ──────────────────────────────────────────────────
  // Le libellé "Facture" est trop ambigu (présent dans le titre "FACTURE
  // FOURNISSEUR") — on cible explicitement "Numéro" / "N°".
  const docNumMatch = findFirstMatch(text, [
    /\bNum[ée]ro\b\s*:?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
    /\bFacture\s+N[°o]\b\s*:?\s*([A-Z0-9][A-Z0-9._/-]{2,})/i,
  ]);
  const documentNumber = docNumMatch?.[1]?.trim() ?? '';

  // ── Dates ──────────────────────────────────────────────────────────────
  const dateMatch = findFirstMatch(text, [
    /Date\s+d['']?[ée]mission\s*[:\s]\s*(\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]\d{4})/i,
    /Date\s+facture\s*[:\s]\s*(\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]\d{4})/i,
    /Date\s*[:\s]\s*(\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]\d{4})/i,
  ]);
  const documentDate = dateMatch ? toIsoDate(dateMatch[1]) : null;

  const dueMatch = text.match(
    /Date\s+d['']?[ée]ch[ée]ance\s*[:\s]\s*(\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]\d{4})/i,
  );
  const dueDate = dueMatch ? toIsoDate(dueMatch[1]) : null;

  // ── Devise ─────────────────────────────────────────────────────────────
  const currencyMatch = text.match(/\b(EUR|USD|GBP|CHF|JPY)\b/);
  const currency = currencyMatch?.[1] ?? 'EUR';

  // ── Totaux ─────────────────────────────────────────────────────────────
  // On cible les libellés explicites ; éviter de capter une valeur de ligne.
  const htMatch = text.match(/Total\s+HT[\s:]*([\d\s.,]+?)(?:\s*(?:EUR|USD|€|\$)|\n)/i);
  const vatMatch = text.match(/TVA\s+totale[\s:]*([\d\s.,]+?)(?:\s*(?:EUR|USD|€|\$)|\n)/i);
  const ttcMatch = text.match(/TOTAL\s+TTC[\s:]*([\d\s.,]+?)(?:\s*(?:EUR|USD|€|\$)|\n)/i);

  const totalExclTax = htMatch ? num(htMatch[1]) : '0';
  const totalTax = vatMatch ? num(vatMatch[1]) : '0';
  const totalInclTax = ttcMatch ? num(ttcMatch[1]) : '0';

  // ── Scores de confiance ────────────────────────────────────────────────
  const confidence = {
    supplier: siretClean ? 95 : tva ? 90 : supplierName ? 55 : 0,
    documentNumber: documentNumber ? 90 : 0,
    documentDate: documentDate ? 90 : 0,
    totals: ttcMatch && htMatch ? 90 : ttcMatch || htMatch ? 50 : 0,
  };

  return {
    supplierPaIdentifier: siretClean ?? tva ?? '',
    supplierNameRaw: supplierName,
    documentNumber,
    documentDate,
    dueDate,
    currency,
    totalExclTax,
    totalTax,
    totalInclTax,
    confidence,
  };
}
