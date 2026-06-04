import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

// ─── Erreur de validation métier ─────────────────────────────────────────────

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceValidationError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

// Remise (allowance) ou charge (charge) — au niveau ligne (BG-27/28) ou document (BG-20/21).
// EN16931 : ChargeIndicator false=remise, true=charge. Les codes motifs proviennent des
// listes officielles UNTDID 5189 (remises) et UNTDID 7161 (charges). Au niveau document,
// la catégorie TVA (vatCategory/vatRate) est OBLIGATOIRE car elle modifie la base de TVA ;
// au niveau ligne, la remise/charge hérite de la catégorie TVA de la ligne (champs ignorés).
export interface AllowanceChargeInput {
  isCharge: boolean; // false = remise (BT-136/92), true = charge (BT-141/99)
  amount: number; // BT-136/141 (ligne) ou BT-92/99 (document)
  reason?: string; // BT-139/144 (ligne) ou BT-97/104 (document)
  reasonCode?: string; // BT-140/145 (UNTDID 7161 charge) ou BT-98 (UNTDID 5189 remise)
  // Document uniquement :
  vatCategory?: string; // BT-95/102 — catégorie TVA (obligatoire au niveau document)
  vatRate?: number; // BT-96/103 — taux TVA de la catégorie
}

export interface InvoiceGenLine {
  description: string;
  name?: string; // cbc:Name dans cac:Item (si absent, utilise description)
  quantity: number;
  unitCode?: string; // ex: C62, HUR — défaut C62
  unitPrice: number;
  taxRate: number; // pourcentage, ex : 20 pour 20 %
  taxCategoryCode?: string; // S, E, K, Z, AE — défaut S si taxRate>0, Z sinon
  // Requis pour catégorie E (exonéré) — code VATEX-EU-* ou équivalent
  taxExemptionReasonCode?: string;
  // Texte libre de justification (recommandé si catégorie E)
  taxExemptionReason?: string;
  // cbc:AccountingCost dans InvoiceLine — compte de charge classe 6 (ex: 622600).
  // Champ UBL 2.1 standard utilisé pour transporter la référence comptable acheteur.
  accountingCode?: string;
  accountingLabel?: string; // Libellé du compte (affiché dans le PDF)
  // Remises/charges de ligne (BG-27/28) — héritent de la catégorie TVA de la ligne.
  allowanceCharges?: AllowanceChargeInput[];
}

export interface InvoiceGenSupplier {
  name: string;
  legalForm?: string; // ex: SAS au capital de 50 000 EUR
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  taxId?: string; // N° TVA intracommunautaire
  siret?: string;
  // Code de routage CTC (EAS 0225) — requis pour un vendeur étranger/OSS non mappable
  // sur un EAS de TVA national. Entrée de génération non persistée (cf. routingCode buyer).
  routingCode?: string;
  iban?: string;
  bic?: string;
  phone?: string;
  email?: string;
}

export interface InvoiceGenData {
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate?: string;
  currency: string; // ISO 4217, ex : EUR
  // BT-6 — devise de comptabilisation de la TVA (défaut EUR). Si ≠ currency,
  // un second cac:TaxTotal portant la TVA convertie (BT-111) est émis.
  taxCurrency?: string;
  // Taux de conversion devise facture → devise de comptabilisation (obligatoire si taxCurrency ≠ currency).
  taxExchangeRate?: number;
  // BT-72 — date de livraison / fin de prestation.
  deliveryDate?: string; // YYYY-MM-DD
  // BT-3 — type de document. ADVANCE_CREDIT_NOTE = avoir de facture d'acompte (TypeCode 503).
  // SELF_BILLED = autofacturation (389), FACTORING = affacturage (393) : tous deux restent
  // des FACTURES (Invoice/InvoiceTypeCode), pas des avoirs.
  direction:
    | 'INVOICE'
    | 'CREDIT_NOTE'
    | 'ADVANCE_INVOICE'
    | 'CORRECTIVE_INVOICE'
    | 'ADVANCE_CREDIT_NOTE'
    | 'SELF_BILLED'
    | 'FACTORING';
  prepaidAmount?: number; // BT-113 — montant acompte déjà versé (0 ou absent = aucun)
  // Statut de paiement à l'émission — pilote le chiffre 1 (non payée) vs 2 (déjà payée)
  // du cadre de facturation BT-23. Défaut : 'unpaid'.
  paymentStatus?: 'unpaid' | 'paid';
  // BT-9 — date de paiement d'une facture « déjà payée » (cadre chiffre 2). Quand le cadre
  // calculé vaut le chiffre 2 (B2/S2/M2), la DueDate émise = paymentDate (ou invoiceDate si
  // vide) ; non persistée (entrée de génération uniquement). Voir BR-FR-CO-09.
  paymentDate?: string; // YYYY-MM-DD
  correctedInvoiceRef?: string; // BT-3 — ID de la facture originale (TypeCode 384)
  supplier: InvoiceGenSupplier;
  buyerName?: string;
  buyerSiret?: string;
  buyerVatNumber?: string;
  buyerLegalForm?: string;
  buyerAddress?: string;
  buyerCity?: string;
  buyerPostalCode?: string;
  buyerCountry?: string;
  // Code de routage CTC (EAS 0225) acheteur — requis pour un acheteur étranger/OSS non
  // mappable sur un EAS de TVA national. Entrée de génération non persistée.
  buyerRoutingCode?: string;
  // BT-10 — référence de routage acheteur. Si absent, le numéro de facture est utilisé.
  buyerReference?: string;
  // BT-13 — référence de la commande acheteur
  orderReference?: string;
  // BT-14 — référence de la commande vendeur (Supplier Reference)
  salesOrderId?: string;
  // CIUS-FR : 1=Biens, 2=Services, 3=Mixte
  typeTransaction?: '1' | '2' | '3';
  // CIUS-FR : S=Sur les débits, E=Sur les encaissements
  optionTVA?: 'S' | 'E';
  lines: InvoiceGenLine[];
  // Remises/charges au niveau document (BG-20/21) — catégorie TVA (vatCategory) obligatoire.
  documentAllowanceCharges?: AllowanceChargeInput[];
  // BG-10 / BT-59-61 — partie bénéficiaire du paiement (cac:PayeeParty). Émise si name est
  // renseigné. OBLIGATOIRE pour l'affacturage (FACTORING / 393) : c'est le factor cessionnaire.
  // Le compte bancaire (IBAN, BT-84) reste porté par PaymentMeans (supplier.iban) — pour
  // l'affacturage, l'utilisateur y saisit l'IBAN du factor ; on ne duplique pas le bloc bancaire.
  payee?: { name: string; identifier?: string; legalId?: string };
  // BG-1 / BT-21-22 — mentions structurées (0..n). Remplace `note` (string, déprécié).
  notes?: InvoiceNote[];
  // Déprécié : note libre unique. Conservée pour compatibilité ascendante (convertie en 1 note).
  note?: string;
}

// BG-1 — note de facture : texte (BT-22) + code sujet optionnel (BT-21, UNTDID 4451).
export interface InvoiceNote {
  subjectCode?: string; // BT-21 — UNTDID 4451 (n'est émis dans le XML que si confirmé, cf. CONFIRMED_NOTE_SUBJECT_CODES)
  text: string; // BT-22 — texte libre de la note
}

export interface ComputedLine extends InvoiceGenLine {
  lineNo: number;
  grossLineAmount: number; // round2(qty × prixUnitaire), avant remises/charges de ligne
  lineAllowanceTotal: number; // Σ remises de ligne (BT-136)
  lineChargeTotal: number; // Σ charges de ligne (BT-141)
  amountExclTax: number; // BT-131 — montant net de ligne (= gross − remises + charges)
  taxAmount: number; // TVA indicative de la ligne (net × taux) — affichage PDF uniquement
  amountInclTax: number; // net + TVA indicative — affichage PDF uniquement
}

// Base et TVA par catégorie (BT-116 / BT-117) — calcul EN16931 par catégorie+taux.
export interface ComputedTaxCategory {
  cat: string;
  rate: number;
  taxable: number; // BT-116 — base TVA de la catégorie (après remises/charges document)
  tax: number; // BT-117 — TVA de la catégorie = round2(BT-116 × taux)
  exemptionCode?: string;
  exemptionReason?: string;
}

export interface ComputedAmounts {
  computedLines: ComputedLine[];
  lineExtensionTotal: number; // BT-106 — Σ BT-131
  allowanceTotal: number; // BT-107 — Σ remises document
  chargeTotal: number; // BT-108 — Σ charges document
  taxExclusiveAmount: number; // BT-109 — BT-106 − BT-107 + BT-108
  taxCategories: ComputedTaxCategory[]; // BG-23 — ventilation TVA
  totalTax: number; // BT-110 — Σ BT-117
  taxInclusiveAmount: number; // BT-112 — BT-109 + BT-110
  prepaidAmount: number; // BT-113
  payableAmount: number; // BT-115 — BT-112 − BT-113
  // Alias de compatibilité (sémantique historique conservée) :
  totalExclTax: number; // = lineExtensionTotal (BT-106)
  totalInclTax: number; // = taxInclusiveAmount (BT-112)
}

export interface GeneratedInvoice {
  xmlContent: string;
  xmlFilename: string;
  pdfFilename: string;
  zipFilename: string;
  summary: {
    invoiceNumber: string;
    direction: string;
    supplierName: string;
    supplierIdentifier: string;
    totalExclTax: number;
    totalTax: number;
    totalInclTax: number;
    prepaidAmount: number;
    payableAmount: number;
    currency: string;
    lineCount: number;
    // BT-23 — cadre de facturation calculé (lettre B/S/M + chiffre 1/2/4), ex. « S1 ».
    cadreCode: string;
    cadreLabel: string;
    // Alerte non bloquante : la lettre inférée des lignes diverge de typeTransaction.
    cadreWarning?: string;
    // BT-34/BT-49 — false si un cbc:EndpointID a été omis (vendeur ou acheteur étranger/OSS
    // non mappable sur un EAS et sans routingCode) : facture EN16931 valide mais non routable
    // Peppol (voie PPF/e-reporting).
    peppolRoutable: boolean;
  };
}

export interface SupplierEnrichment {
  name: string;
  address?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  taxId?: string;
  siret?: string;
  source: 'PAPPERS' | 'INSEE';
}

// ─── Utilitaires internes ─────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Catégorie TVA effective d'une ligne (défaut : Z si taux 0, S sinon).
function lineTaxCategory(line: InvoiceGenLine): string {
  if (line.taxCategoryCode) return line.taxCategoryCode;
  return line.taxRate === 0 ? 'Z' : 'S';
}

// ─── Cadre de facturation BT-23 (matrice B/S/M × 1/2/4) ───────────────────────
// Référentiel : AFNOR XP Z12-012 (socle Réforme Facture électronique), règle
// BR-FR-08. Le cadre est porté par BT-23 = cbc:ProfileID (le BT-24 / CustomizationID
// reste l'URN EN16931 + CIUS-FR, inchangé). Valeur = code court (ex. « S1 »).
// 1ʳᵉ lettre = nature (B=bien, S=service, M=mixte) ; chiffre = processus
// (1=non payée, 2=déjà payée, 4=définitive après acompte).

export type CadreLetter = 'B' | 'S' | 'M';
export type CadreDigit = '1' | '2' | '4';

export interface CadreResult {
  code: string; // ex. « S1 », « M4 »
  letter: CadreLetter; // lettre émise (= inférée des lignes)
  digit: CadreDigit;
  label: string; // libellé humain, ex. « S1 — prestation de services, non payée »
  inferredLetter: CadreLetter; // lettre inférée de accountingCode
  transactionLetter: CadreLetter | null; // lettre dérivée de typeTransaction (si fourni)
  divergence: boolean; // true si inferredLetter ≠ transactionLetter (alerte non bloquante)
  documentTypeCode: string; // BT-3
}

// BT-3 — type de document (UNTDID 1001) à partir de la direction.
export function documentTypeCode(direction: InvoiceGenData['direction']): string {
  switch (direction) {
    case 'CREDIT_NOTE':
      return '381';
    case 'ADVANCE_CREDIT_NOTE':
      return '503';
    case 'ADVANCE_INVOICE':
      return '386';
    case 'CORRECTIVE_INVOICE':
      return '384';
    case 'SELF_BILLED':
      return '389'; // Autofacturation (UNTDID 1001) — reste une facture
    case 'FACTORING':
      return '393'; // Affacturage — facture cédée à un factor (reste une facture)
    default:
      return '380';
  }
}

// Libellé humain du type de document (PDF + UI) — code BT-3 entre parenthèses.
export function directionLabel(direction: InvoiceGenData['direction']): string {
  switch (direction) {
    case 'CREDIT_NOTE':
      return 'Avoir (381)';
    case 'ADVANCE_CREDIT_NOTE':
      return "Avoir d'acompte (503)";
    case 'ADVANCE_INVOICE':
      return "Facture d'acompte (386)";
    case 'CORRECTIVE_INVOICE':
      return 'Facture rectificative (384)';
    case 'SELF_BILLED':
      return 'Autofacturation (389)';
    case 'FACTORING':
      return 'Affacturage (393)';
    default:
      return 'Facture (380)';
  }
}

// Nature d'une ligne déduite de la classe PCG du compte de charge :
// - classe 60 (achats : marchandises, matières, fournitures) → Bien
// - 61/62 (services extérieurs) et 63-67 (impôts, personnel, gestion courante,
//   financières, exceptionnelles) → Service (défaut, frais généraux).
function lineNature(accountingCode?: string): 'B' | 'S' {
  return (accountingCode ?? '').trim().startsWith('60') ? 'B' : 'S';
}

// Agrégation document : toutes Biens → B ; toutes Services → S ; mélange → M.
function inferDocumentLetter(lines: InvoiceGenLine[]): CadreLetter {
  let hasBien = false;
  let hasService = false;
  for (const line of lines) {
    if (lineNature(line.accountingCode) === 'B') hasBien = true;
    else hasService = true;
  }
  if (hasBien && hasService) return 'M';
  if (hasBien) return 'B';
  return 'S'; // toutes services, ou aucune ligne
}

// Lettre dérivée de typeTransaction CIUS-FR : 1→B, 2→S, 3→M.
function transactionLetter(typeTransaction?: '1' | '2' | '3'): CadreLetter | null {
  if (typeTransaction === '1') return 'B';
  if (typeTransaction === '2') return 'S';
  if (typeTransaction === '3') return 'M';
  return null;
}

const CADRE_LETTER_LABEL: Record<CadreLetter, string> = {
  B: 'livraison de biens',
  S: 'prestation de services',
  M: 'mixte (biens + services)',
};
const CADRE_DIGIT_LABEL: Record<CadreDigit, string> = {
  '1': 'non payée',
  '2': 'déjà payée',
  '4': 'définitive après acompte',
};

// Détermine le cadre de facturation complet (lettre + chiffre + contrôle de cohérence).
// La lettre ÉMISE est celle inférée des lignes (reflète le contenu réel) ; en cas de
// divergence avec typeTransaction, une alerte non bloquante est renseignée.
export function computeCadre(data: InvoiceGenData): CadreResult {
  const typeCode = documentTypeCode(data.direction);
  const inferred = inferDocumentLetter(data.lines);
  const txLetter = transactionLetter(data.typeTransaction);
  const divergence = txLetter !== null && txLetter !== inferred;

  // Chiffre : 4 réservé à la facture définitive après acompte. Concerne les factures
  // « commerciales » : 380, ainsi que l'autofacturation (389) et l'affacturage (393), qui
  // suivent la même logique que le 380. Les avoirs (381/503), la rectificative (384) et
  // l'acompte (386) ne produisent JAMAIS 4 (BR-FR-CO-08). Sinon : 2 si déjà payée, 1 sinon.
  const COMMERCIAL_TYPES = new Set(['380', '389', '393']);
  const prepaid = data.prepaidAmount ?? 0;
  const paid = data.paymentStatus === 'paid';
  const digit: CadreDigit = COMMERCIAL_TYPES.has(typeCode) && prepaid > 0 ? '4' : paid ? '2' : '1';

  const letter = inferred;
  const code = `${letter}${digit}`;
  const label = `${code} — ${CADRE_LETTER_LABEL[letter]}, ${CADRE_DIGIT_LABEL[digit]}`;

  return {
    code,
    letter,
    digit,
    label,
    inferredLetter: inferred,
    transactionLetter: txLetter,
    divergence,
    documentTypeCode: typeCode,
  };
}

// Message d'alerte de cohérence (lettre lignes vs typeTransaction), ou undefined.
export function cadreDivergenceWarning(cadre: CadreResult): string | undefined {
  if (!cadre.divergence || cadre.transactionLetter === null) return undefined;
  return (
    `Cadre BT-23 : la nature inférée des lignes (${cadre.inferredLetter}) diverge du ` +
    `type de transaction CIUS-FR saisi (${cadre.transactionLetter}). ` +
    `La valeur émise est « ${cadre.code} » (inférée des lignes) — réconciliez typeTransaction.`
  );
}

// ─── EndpointID (BT-34 / BT-49) — schemes Peppol EAS ──────────────────────────
// Mapping préfixe pays du n° de TVA → code EAS Peppol pour les identifiants
// « XX:VAT ». Source : Peppol Code List « Electronic Address Scheme (EAS) »
// (docs.peppol.eu/poacc/billing/3.0/codelist/eas/), relevée et NON devinée. Les
// codes EAS de TVA sont STRICTEMENT nationaux : il n'existe AUCUN code pour la TVA
// OSS « EU » (guichet unique). Le préfixe TVA grec est « EL » (= code pays GR 9933) ;
// la Partita IVA italienne porte le code 0211. On NE met JAMAIS 9957 (FR:VAT) — ni
// aucun scheme national — pour un identifiant non rattachable à ce pays.
const VAT_EAS_BY_PREFIX: Record<string, string> = {
  HU: '9910',
  AT: '9914',
  ES: '9920',
  AD: '9922',
  AL: '9923',
  BA: '9924',
  BE: '9925',
  BG: '9926',
  CH: '9927',
  CY: '9928',
  CZ: '9929',
  DE: '9930',
  EE: '9931',
  GB: '9932',
  EL: '9933', // Grèce — préfixe TVA « EL »
  GR: '9933', // Grèce — alias code pays ISO « GR » (même scheme 9933)
  HR: '9934',
  IE: '9935',
  IT: '0211', // Italie — Partita IVA (code EAS 0211)
  LI: '9936',
  LT: '9937',
  LU: '9938',
  LV: '9939',
  MC: '9940',
  ME: '9941',
  MK: '9942',
  MT: '9943',
  NL: '9944',
  PL: '9945',
  PT: '9946',
  RO: '9947',
  RS: '9948',
  SI: '9949',
  SK: '9950',
  SM: '9951',
  TR: '9952',
  VA: '9953',
  FR: '9957',
};

// EAS « FRCTC ELECTRONIC ADDRESS » — adresse de routage CTC française. HYPOTHÈSE
// (à valider PDP/AIFE) : scheme attendu pour router un vendeur/acheteur étranger ou
// OSS « EU » non mappable sur un EAS de TVA national. La valeur portée est alors le
// CODE DE ROUTAGE (routingCode), jamais la TVA OSS.
const FRCTC_EAS_SCHEME = '0225';

function vatEasScheme(vat: string): string | null {
  const prefix = vat.trim().slice(0, 2).toUpperCase();
  return VAT_EAS_BY_PREFIX[prefix] ?? null;
}

// Résolution de l'EndpointID (BT-34/BT-49) d'une partie. Arbre de décision n'émettant
// JAMAIS un scheme faux (cf. CR_Correction_EndpointID_EUOSS) :
//   1. SIRET     → 0009
//   2. SIREN     → 0002
//   3. TVA       → EAS national si le préfixe mappe ; sinon (EU/OSS ou préfixe inconnu) :
//        routingCode fourni → 0225 (FRCTC, valeur = routingCode) ; sinon non routable.
//   4. rien      → non routable.
// routable = false ⇒ aucun cbc:EndpointID émis (document EN16931 valide — BT-34/49
// optionnel — mais non routable Peppol : voie PPF/e-reporting).
interface EndpointParty {
  siret?: string;
  siren?: string;
  vat?: string;
  routingCode?: string;
}
interface EndpointResolution {
  schemeID?: string;
  value?: string;
  routable: boolean;
  // n° de TVA non mappable (EU/OSS ou préfixe inconnu) sans routingCode → trace TODO.
  unmappedVatPrefix?: string;
}

function resolveEndpoint(party: EndpointParty): EndpointResolution {
  if (party.siret) return { schemeID: '0009', value: party.siret, routable: true };
  if (party.siren) return { schemeID: '0002', value: party.siren, routable: true };
  if (party.vat) {
    const scheme = vatEasScheme(party.vat);
    if (scheme) return { schemeID: scheme, value: party.vat, routable: true };
    // Préfixe « EU » (OSS) ou inconnu : pas de scheme de TVA possible — hypothèse 0225.
    if (party.routingCode) {
      return { schemeID: FRCTC_EAS_SCHEME, value: party.routingCode, routable: true };
    }
    return { routable: false, unmappedVatPrefix: party.vat.trim().slice(0, 2) };
  }
  return { routable: false };
}

// Sérialise une résolution en bloc XML cbc:EndpointID. Si non routable et que la cause
// est une TVA non mappable, laisse un commentaire TODO documenté (jamais d'EndpointID
// sans schemeID valide, jamais de scheme faux).
function buildEndpointXml(res: EndpointResolution): string {
  if (res.schemeID && res.value) {
    return `
      <cbc:EndpointID schemeID="${res.schemeID}">${escapeXml(res.value)}</cbc:EndpointID>`;
  }
  if (res.unmappedVatPrefix) {
    return `
      <!-- TODO EAS : partie étrangère/OSS (préfixe TVA "${escapeXml(res.unmappedVatPrefix)}") non routable Peppol — fournir un routingCode (hypothèse 0225, à valider PDP/AIFE) -->`;
  }
  return '';
}

// Indique si la facture est routable Peppol : un EndpointID a-t-il pu être émis pour
// le vendeur ET l'acheteur ? (false si l'un des deux a été omis). Exposé dans summary.
export function computePeppolRoutable(data: InvoiceGenData): boolean {
  const supplier = resolveEndpoint({
    siret: data.supplier.siret,
    vat: data.supplier.taxId,
    routingCode: data.supplier.routingCode,
  });
  const buyer = resolveEndpoint({
    siret: data.buyerSiret,
    vat: data.buyerVatNumber,
    routingCode: data.buyerRoutingCode,
  });
  return supplier.routable && buyer.routable;
}

function getGeneratedDir(): string {
  const base = process.env.FILE_STORAGE_PATH
    ? path.join(process.env.FILE_STORAGE_PATH, 'generated')
    : path.join(process.cwd(), 'data', 'generated');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function buildFilename(invoiceNumber: string, ext: string): string {
  const safe = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 60);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return `GEN_${safe}_${ts}.${ext}`;
}

// ─── Validation frais de gestion ─────────────────────────────────────────────

export function validateExpenseLines(lines: InvoiceGenLine[]): void {
  for (const line of lines) {
    if (!line.accountingCode || line.accountingCode.trim() === '') {
      throw new InvoiceValidationError(
        `Ligne "${line.description}" : le compte comptable de charge est obligatoire. ` +
          `Renseignez un compte de charges classe 6 (ex : 622600 pour honoraires).`,
      );
    }
    if (!line.accountingCode.trim().startsWith('6')) {
      throw new InvoiceValidationError(
        `Ligne "${line.description}" : le compte "${line.accountingCode}" n'est pas un compte ` +
          `de charges classe 6. Seuls les comptes commençant par 6 sont autorisés dans le ` +
          `générateur de frais de gestion (comptes de vente, immobilisations et stocks interdits).`,
      );
    }
  }
}

// ─── Validation remises/charges (EN16931 BR-CO-05/06, BR-32/BR-43) ────────────

export function validateAllowanceCharges(data: InvoiceGenData): void {
  const checkBase = (ac: AllowanceChargeInput, where: string): void => {
    const kind = ac.isCharge ? 'charge' : 'remise';
    if (ac.amount === undefined || ac.amount === null || ac.amount <= 0) {
      throw new InvoiceValidationError(
        `${where} : la ${kind} doit avoir un montant strictement positif (BR-CO-05/06).`,
      );
    }
    if (!ac.reason?.trim() && !ac.reasonCode?.trim()) {
      throw new InvoiceValidationError(
        `${where} : la ${kind} doit porter un motif (texte) OU un code motif ` +
          `(UNTDID ${ac.isCharge ? '7161' : '5189'}) — BR-33 / BR-42.`,
      );
    }
  };

  data.lines.forEach((line, idx) => {
    for (const ac of line.allowanceCharges ?? []) {
      checkBase(ac, `Ligne ${idx + 1} ("${line.description}")`);
    }
  });

  for (const ac of data.documentAllowanceCharges ?? []) {
    checkBase(ac, 'Remise/charge document');
    if (!ac.vatCategory?.trim()) {
      throw new InvoiceValidationError(
        `Remise/charge document : une catégorie TVA (vatCategory) est obligatoire ` +
          `car elle modifie la base de TVA de cette catégorie (BR-32 / BR-43).`,
      );
    }
  }
}

// ─── Mentions structurées BT-21 (BG-1) ───────────────────────────────────────

// Sous-ensemble de codes UNTDID 4451 (« Text subject qualifier ») confirmés valides pour
// BT-21 (sujet d'une note). Le code n'est émis dans le XML (préfixe « CODE# » de cbc:Note,
// convention EN16931-UBL) QUE s'il figure ici. Tout autre code (ex. BLU « éco-participation »,
// INV « autofacturation » — qui relèvent du segment COM Factur-X et NON de 4451) est émis en
// TEXTE SEUL, sans subjectCode, plutôt qu'un code faux (cf. CR, garde-fou « ne pas deviner »).
//   AAI = informations générales · SUR = remarques du vendeur · REG = informations réglementaires
//   ABL = informations légales · TXD = déclaration fiscale · CUS = informations douanières
//   AAB = conditions de paiement (utilisé pour l'escompte)
const CONFIRMED_NOTE_SUBJECT_CODES = new Set(['AAI', 'SUR', 'REG', 'ABL', 'TXD', 'CUS', 'AAB']);

// True si le code sujet est confirmé et peut être émis comme préfixe BT-21 dans cbc:Note.
export function isConfirmedNoteSubjectCode(code?: string): boolean {
  return !!code && CONFIRMED_NOTE_SUBJECT_CODES.has(code.trim().toUpperCase());
}

// Résout la liste finale des notes (BG-1) à émettre :
//  1. `notes` (tableau structuré) si fourni ; sinon `note` (string, déprécié) converti en 1 entrée.
//  2. Mention auto « Autofacturation » pour SELF_BILLED (389) si non déjà saisie.
//  3. Mention auto de subrogation pour FACTORING (393) si non déjà saisie (subjectCode ABL).
// L'auto-complétion est analogue à celle de l'autoliquidation (catégorie AE) : on n'ajoute
// la mention que si l'utilisateur ne l'a pas déjà fournie.
export function resolveNotes(data: InvoiceGenData): InvoiceNote[] {
  const notes: InvoiceNote[] =
    data.notes && data.notes.length
      ? data.notes.filter((n) => n.text?.trim()).map((n) => ({ ...n }))
      : data.note?.trim()
        ? [{ text: data.note.trim() }]
        : [];

  if (data.direction === 'SELF_BILLED' && !notes.some((n) => /autofacturation/i.test(n.text))) {
    // INV (code COM Factur-X) n'est pas un code UNTDID 4451 confirmé → mention en texte seul.
    notes.push({ text: 'Autofacturation' });
  }
  if (
    data.direction === 'FACTORING' &&
    !notes.some((n) => /subrogation|cédée|cedee|factor/i.test(n.text))
  ) {
    notes.push({
      subjectCode: 'ABL', // UNTDID 4451 « informations légales » — confirmé
      text: 'Facture cédée — règlement à effectuer au bénéficiaire/factor indiqué (subrogation).',
    });
  }
  return notes;
}

// ─── Validation partie bénéficiaire (BG-10 / affacturage) ─────────────────────

export function validatePayee(data: InvoiceGenData): void {
  if (data.direction === 'FACTORING' && !data.payee?.name?.trim()) {
    throw new InvoiceValidationError(
      `Affacturage (type 393) : le bénéficiaire/factor (payee.name, BT-59) est obligatoire. ` +
        `C'est la partie cessionnaire à laquelle le règlement doit être adressé après cession ` +
        `de la créance (subrogation).`,
    );
  }
}

// ─── Calcul des montants ──────────────────────────────────────────────────────

// Somme (arrondie au centime) des remises et des charges d'un lot d'AllowanceCharge.
function sumAllowanceCharges(acs?: AllowanceChargeInput[]): { allowance: number; charge: number } {
  let allowance = 0;
  let charge = 0;
  for (const ac of acs ?? []) {
    if (ac.isCharge) charge = round2(charge + ac.amount);
    else allowance = round2(allowance + ac.amount);
  }
  return { allowance, charge };
}

// Calcul complet EN16931 : montants nets de ligne (BT-131), totaux remises/charges
// document (BT-107/108), base hors taxe (BT-109), ventilation TVA par catégorie
// (BT-116/117, calcul base×taux et NON arrondi par ligne), TTC (BT-112) et net à payer
// (BT-115). La TVA est calculée par catégorie car une remise/charge décale la base.
export function computeAmounts(
  lines: InvoiceGenLine[],
  documentAllowanceCharges?: AllowanceChargeInput[],
  prepaidAmount?: number,
  // BR-FR-CO-09 — cadre « déjà payée » (chiffre 2) : force le PrepaidAmount émis (BT-113) à
  // l'égalité avec le TTC (BT-112), d'où un PayableAmount (BT-115) nul. Indépendant du champ
  // d'entrée prepaidAmount (acompte, qui déclenche le chiffre 4) : le chiffre du cadre fait foi.
  forcePrepaidToInclusive = false,
): ComputedAmounts {
  // BT-131 — montant net de chaque ligne (= qty×PU − remises ligne + charges ligne).
  const computedLines: ComputedLine[] = lines.map((line, idx) => {
    const grossLineAmount = round2(line.quantity * line.unitPrice);
    const { allowance, charge } = sumAllowanceCharges(line.allowanceCharges);
    const amountExclTax = round2(grossLineAmount - allowance + charge);
    // TVA indicative de ligne (affichage PDF) — le total TVA reste calculé par catégorie.
    const taxAmount = round2((amountExclTax * line.taxRate) / 100);
    return {
      ...line,
      lineNo: idx + 1,
      grossLineAmount,
      lineAllowanceTotal: allowance,
      lineChargeTotal: charge,
      amountExclTax,
      taxAmount,
      amountInclTax: round2(amountExclTax + taxAmount),
    };
  });

  // BT-106 — somme des montants nets de ligne.
  const lineExtensionTotal = round2(
    computedLines.reduce((acc, l) => round2(acc + l.amountExclTax), 0),
  );

  // BT-107 / BT-108 — totaux des remises et charges au niveau document.
  const { allowance: allowanceTotal, charge: chargeTotal } =
    sumAllowanceCharges(documentAllowanceCharges);

  // BT-109 — base hors taxe = BT-106 − BT-107 + BT-108.
  const taxExclusiveAmount = round2(lineExtensionTotal - allowanceTotal + chargeTotal);

  // Ventilation TVA par (catégorie + taux). La base inclut les nets de ligne puis les
  // remises/charges document de la même catégorie (BT-116).
  interface CatAccum {
    cat: string;
    rate: number;
    taxable: number;
    exemptionCode?: string;
    exemptionReason?: string;
  }
  const cats = new Map<string, CatAccum>();
  const catKey = (cat: string, rate: number) => `${cat}|${rate}`;

  for (const line of computedLines) {
    const cat = lineTaxCategory(line);
    const key = catKey(cat, line.taxRate);
    const g = cats.get(key) ?? {
      cat,
      rate: line.taxRate,
      taxable: 0,
      exemptionCode: line.taxExemptionReasonCode,
      exemptionReason: line.taxExemptionReason,
    };
    g.taxable = round2(g.taxable + line.amountExclTax);
    cats.set(key, g);
  }
  for (const ac of documentAllowanceCharges ?? []) {
    const cat = ac.vatCategory ?? (ac.vatRate ? 'S' : 'Z');
    const rate = ac.vatRate ?? 0;
    const key = catKey(cat, rate);
    const g = cats.get(key) ?? { cat, rate, taxable: 0 };
    g.taxable = round2(g.taxable + (ac.isCharge ? ac.amount : -ac.amount));
    cats.set(key, g);
  }

  const taxCategories: ComputedTaxCategory[] = Array.from(cats.values()).map((g) => ({
    ...g,
    tax: round2((g.taxable * g.rate) / 100), // BT-117 — calcul par catégorie (BR-CO-17)
  }));

  // BT-110 — TVA totale = Σ BT-117.
  const totalTax = round2(taxCategories.reduce((acc, c) => round2(acc + c.tax), 0));
  // BT-112 — TTC.
  const taxInclusiveAmount = round2(taxExclusiveAmount + totalTax);
  // BT-113 / BT-115. Cas chiffre 2 (BR-FR-CO-09) : PrepaidAmount émis = TTC → net à payer = 0.
  const prepaid = forcePrepaidToInclusive ? taxInclusiveAmount : round2(prepaidAmount ?? 0);
  const payableAmount = round2(Math.max(0, taxInclusiveAmount - prepaid));

  return {
    computedLines,
    lineExtensionTotal,
    allowanceTotal,
    chargeTotal,
    taxExclusiveAmount,
    taxCategories,
    totalTax,
    taxInclusiveAmount,
    prepaidAmount: prepaid,
    payableAmount,
    totalExclTax: lineExtensionTotal,
    totalInclTax: taxInclusiveAmount,
  };
}

// Calcule les montants à émettre pour une facture complète, en appliquant l'override
// BR-FR-CO-09 quand le cadre calculé vaut le chiffre 2 (facture déjà payée). L'override est
// piloté UNIQUEMENT par le chiffre du cadre (computeCadre), jamais par le champ d'entrée
// prepaidAmount — ce qui garantit qu'il ne rétroagit pas sur la détermination du cadre.
export function computeAmountsForData(data: InvoiceGenData): ComputedAmounts {
  const cadre = computeCadre(data);
  return computeAmounts(
    data.lines,
    data.documentAllowanceCharges,
    data.prepaidAmount,
    cadre.digit === '2',
  );
}

// BT-9 — date d'échéance/de paiement effective émise. Pour le cadre chiffre 2 (déjà payée,
// BR-FR-CO-09) : paymentDate (ou invoiceDate à défaut). Sinon : dueDate existant (inchangé).
export function effectiveDueDate(data: InvoiceGenData, cadre: CadreResult): string | undefined {
  if (cadre.digit === '2') return data.paymentDate ?? data.invoiceDate;
  return data.dueDate;
}

// ─── Génération XML UBL 2.1 ──────────────────────────────────────────────────

export function generateUblXml(data: InvoiceGenData): string {
  validateAllowanceCharges(data);
  validatePayee(data);

  // BT-23 — cadre de facturation (porté par cbc:ProfileID, code court ex. « S1 »). Calculé
  // avant les montants : son chiffre pilote l'override BR-FR-CO-09 (cadre 2 = déjà payée).
  const cadre = computeCadre(data);

  const {
    computedLines,
    lineExtensionTotal,
    allowanceTotal,
    chargeTotal,
    taxExclusiveAmount,
    taxCategories,
    totalTax,
    taxInclusiveAmount,
    prepaidAmount: prepaidEmitted,
    payableAmount,
  } = computeAmounts(
    data.lines,
    data.documentAllowanceCharges,
    data.prepaidAmount,
    cadre.digit === '2',
  );

  // BT-6 — devise de comptabilisation TVA : un second TaxTotal (TVA convertie, BT-111)
  // n'est requis que si la devise de comptabilisation diffère de la devise de facture.
  const needsTaxCurrency = !!data.taxCurrency && data.taxCurrency !== data.currency;
  if (needsTaxCurrency && (data.taxExchangeRate === undefined || data.taxExchangeRate === null)) {
    throw new InvoiceValidationError(
      `Devise de comptabilisation TVA (${data.taxCurrency}) différente de la devise de facture ` +
        `(${data.currency}) : le taux de conversion (taxExchangeRate) est obligatoire pour produire ` +
        `le montant de TVA en devise de comptabilisation (BT-111).`,
    );
  }
  const taxTotalInTaxCurrency = needsTaxCurrency
    ? round2(totalTax * (data.taxExchangeRate as number))
    : 0;

  // Un avoir (381) comme un avoir d'acompte (503) sont des documents « typés avoirs »
  // → document CreditNote (CreditNoteLine, CreditNoteTypeCode).
  const isCreditNote = data.direction === 'CREDIT_NOTE' || data.direction === 'ADVANCE_CREDIT_NOTE';
  const rootTag = isCreditNote ? 'CreditNote' : 'Invoice';
  const lineTag = isCreditNote ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = isCreditNote ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const typeCodeTag = isCreditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode';
  const typeCode = documentTypeCode(data.direction);
  const xmlns = isCreditNote
    ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
    : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';

  // BT-9 — date d'échéance émise (paymentDate/invoiceDate pour le cadre 2, sinon dueDate).
  const dueDateEmitted = effectiveDueDate(data, cadre);

  const fmt = (n: number) => n.toFixed(2);
  const fmt4 = (n: number) => n.toFixed(4);

  const taxCatCode = (line: ComputedLine): string => lineTaxCategory(line);

  // Ventilation TVA par catégorie (BT-116/117), remises/charges document incluses dans la base.
  const taxGroups = taxCategories;

  // Pour la catégorie AE (autoliquidation), EN16931 (BR-AE-*) exige un motif :
  // on auto-complète VATEX-FR-AE / « Autoliquidation » si aucun motif explicite
  // n'a été saisi. Aucune autre catégorie n'est modifiée.
  const renderExemption = (cat: string, code?: string, reason?: string): string => {
    let exCode = code;
    let exReason = reason;
    if (cat === 'AE') {
      exCode = exCode || 'VATEX-FR-AE';
      exReason = exReason || 'Autoliquidation';
    }
    return `${
      exCode
        ? `
        <cbc:TaxExemptionReasonCode>${escapeXml(exCode)}</cbc:TaxExemptionReasonCode>`
        : ''
    }${
      exReason
        ? `
        <cbc:TaxExemptionReason>${escapeXml(exReason)}</cbc:TaxExemptionReason>`
        : ''
    }`;
  };

  const taxSubtotals = taxGroups
    .map(
      (g) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${data.currency}">${fmt(g.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${data.currency}">${fmt(g.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${g.cat}</cbc:ID>
        <cbc:Percent>${g.rate.toFixed(2)}</cbc:Percent>${renderExemption(g.cat, g.exemptionCode, g.exemptionReason)}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join('');

  // Remise/charge (cac:AllowanceCharge). Au niveau ligne : pas de cac:TaxCategory (héritée).
  // Au niveau document : cac:TaxCategory obligatoire (ID + Percent + TaxScheme VAT).
  const renderAllowanceCharge = (ac: AllowanceChargeInput, withTaxCategory: boolean): string => {
    const reasonCode = ac.reasonCode?.trim()
      ? `
      <cbc:AllowanceChargeReasonCode>${escapeXml(ac.reasonCode.trim())}</cbc:AllowanceChargeReasonCode>`
      : '';
    const reason = ac.reason?.trim()
      ? `
      <cbc:AllowanceChargeReason>${escapeXml(ac.reason.trim())}</cbc:AllowanceChargeReason>`
      : '';
    const taxCategory =
      withTaxCategory && ac.vatCategory
        ? `
      <cac:TaxCategory>
        <cbc:ID>${escapeXml(ac.vatCategory)}</cbc:ID>
        <cbc:Percent>${(ac.vatRate ?? 0).toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>`
        : '';
    return `
    <cac:AllowanceCharge>
      <cbc:ChargeIndicator>${ac.isCharge ? 'true' : 'false'}</cbc:ChargeIndicator>${reasonCode}${reason}
      <cbc:Amount currencyID="${data.currency}">${fmt(ac.amount)}</cbc:Amount>${taxCategory}
    </cac:AllowanceCharge>`;
  };

  // InvoiceLine avec cbc:AccountingCost (champ UBL 2.1 standard pour référence comptable acheteur)
  const invoiceLines = computedLines
    .map((line) => {
      const unitCode = line.unitCode ?? 'C62';
      const cat = taxCatCode(line);
      const itemName = line.name ?? line.description;
      const accCost = line.accountingCode
        ? `\n    <cbc:AccountingCost>${escapeXml(line.accountingCode)}</cbc:AccountingCost>`
        : '';
      // BG-27/28 — remises/charges de ligne, placées après AccountingCost et avant cac:Item.
      const lineAc = (line.allowanceCharges ?? [])
        .map((ac) => renderAllowanceCharge(ac, false))
        .join('');
      return `
  <cac:${lineTag}>
    <cbc:ID>${line.lineNo}</cbc:ID>
    <${qtyTag} unitCode="${unitCode}">${fmt4(line.quantity)}</${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(line.amountExclTax)}</cbc:LineExtensionAmount>${accCost}${lineAc}
    <cac:Item>
      <cbc:Description>${escapeXml(line.description)}</cbc:Description>
      <cbc:Name>${escapeXml(itemName)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${cat}</cbc:ID>
        <cbc:Percent>${line.taxRate.toFixed(2)}</cbc:Percent>${renderExemption(cat, line.taxExemptionReasonCode, line.taxExemptionReason)}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${data.currency}">${fmt4(line.unitPrice)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="${unitCode}">1.0000</cbc:BaseQuantity>
    </cac:Price>
  </cac:${lineTag}>`;
    })
    .join('');

  // BT-40 : le pays vendeur est obligatoire (BR-09) → cac:PostalAddress avec au
  // minimum cac:Country est TOUJOURS émis, même si rue et ville sont vides.
  const supplierAddress = `
      <cac:PostalAddress>${
        data.supplier.address
          ? `
        <cbc:StreetName>${escapeXml(data.supplier.address)}</cbc:StreetName>`
          : ''
      }${
        data.supplier.city
          ? `
        <cbc:CityName>${escapeXml(data.supplier.city)}</cbc:CityName>`
          : ''
      }${
        data.supplier.postalCode
          ? `
        <cbc:PostalZone>${escapeXml(data.supplier.postalCode)}</cbc:PostalZone>`
          : ''
      }
        <cac:Country>
          <cbc:IdentificationCode>${data.supplier.country ?? 'FR'}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>`;

  const supplierTaxScheme = data.supplier.taxId
    ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.supplier.taxId)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : '';

  const supplierSiret = data.supplier.siret
    ? `
        <cbc:CompanyID schemeID="0002">${escapeXml(data.supplier.siret)}</cbc:CompanyID>`
    : '';

  const supplierContact =
    data.supplier.phone || data.supplier.email
      ? `
      <cac:Contact>${
        data.supplier.phone
          ? `
        <cbc:Telephone>${escapeXml(data.supplier.phone)}</cbc:Telephone>`
          : ''
      }${
        data.supplier.email
          ? `
        <cbc:ElectronicMail>${escapeXml(data.supplier.email)}</cbc:ElectronicMail>`
          : ''
      }
      </cac:Contact>`
      : '';

  const paymentMeans = data.supplier.iban
    ? `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode name="Virement">30</cbc:PaymentMeansCode>
    <cbc:PaymentID>${escapeXml(data.invoiceNumber)}_PAIEMENT</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${escapeXml(data.supplier.iban)}</cbc:ID>
      <cbc:Name>COMPTE FOURNISSEUR</cbc:Name>${
        data.supplier.bic
          ? `
      <cac:FinancialInstitutionBranch>
        <cbc:ID>${escapeXml(data.supplier.bic)}</cbc:ID>
      </cac:FinancialInstitutionBranch>`
          : ''
      }
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>

  <cac:PaymentTerms>
    <cbc:Note>PAIEMENT 30 JOURS NET — TOUT RETARD ENTRAINE DES PENALITES EGALES A 3 FOIS LE TAUX LEGAL</cbc:Note>
  </cac:PaymentTerms>`
    : '';

  // BT-34 : EndpointID Peppol fournisseur (SIRET → SIREN → EAS de TVA national → 0225 routingCode)
  const supplierEndpoint = buildEndpointXml(
    resolveEndpoint({
      siret: data.supplier.siret,
      vat: data.supplier.taxId,
      routingCode: data.supplier.routingCode,
    }),
  );

  const buyerName = data.buyerName ?? 'DEMO INDUSTRIE SAS';

  // BT-49 : EndpointID Peppol acheteur (même arbre de décision que le vendeur)
  const buyerEndpoint = buildEndpointXml(
    resolveEndpoint({
      siret: data.buyerSiret,
      vat: data.buyerVatNumber,
      routingCode: data.buyerRoutingCode,
    }),
  );

  // BT-50 à BT-55 : adresse acheteur (obligatoire EN16931). Le pays (BT-55, BR-11)
  // est TOUJOURS émis via cac:Country, même si rue/ville/CP sont vides.
  const buyerAddressBlock = `
      <cac:PostalAddress>${
        data.buyerAddress
          ? `
        <cbc:StreetName>${escapeXml(data.buyerAddress)}</cbc:StreetName>`
          : ''
      }${
        data.buyerCity
          ? `
        <cbc:CityName>${escapeXml(data.buyerCity)}</cbc:CityName>`
          : ''
      }${
        data.buyerPostalCode
          ? `
        <cbc:PostalZone>${escapeXml(data.buyerPostalCode)}</cbc:PostalZone>`
          : ''
      }
        <cac:Country>
          <cbc:IdentificationCode>${data.buyerCountry ?? 'FR'}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>`;

  const buyerTaxScheme = data.buyerVatNumber
    ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.buyerVatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : '';

  // BT-44 RegistrationName + BT-47 CompanyID (CIUS-FR : SIRET obligatoire)
  const buyerLegalEntity = `
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(buyerName)}</cbc:RegistrationName>${
          data.buyerSiret
            ? `
        <cbc:CompanyID schemeID="0002">${escapeXml(data.buyerSiret)}</cbc:CompanyID>`
            : ''
        }${
          data.buyerLegalForm
            ? `
        <cbc:CompanyLegalForm>${escapeXml(data.buyerLegalForm)}</cbc:CompanyLegalForm>`
            : ''
        }
      </cac:PartyLegalEntity>`;

  // BT-13 / BT-14 : référence de commande.
  // Si SalesOrderID (BT-14) est présent sans BT-13, émettre <cbc:ID>NA</cbc:ID> (UBL exige l'élément).
  const orderReferenceBlock =
    data.orderReference || data.salesOrderId
      ? `
  <cac:OrderReference>${
    data.orderReference
      ? `
    <cbc:ID>${escapeXml(data.orderReference)}</cbc:ID>`
      : `
    <cbc:ID>NA</cbc:ID>`
  }${
    data.salesOrderId
      ? `
    <cbc:SalesOrderID>${escapeXml(data.salesOrderId)}</cbc:SalesOrderID>`
      : ''
  }
  </cac:OrderReference>`
      : '';

  // BT-3 — référence à la facture corrigée (TypeCode 384)
  const billingReferenceBlock = data.correctedInvoiceRef
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${escapeXml(data.correctedInvoiceRef)}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : '';

  // CIUS-FR : TypeTransaction + OptionTVA
  const cisuFrBlocks =
    data.typeTransaction || data.optionTVA
      ? `${
          data.typeTransaction
            ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>TypeTransaction</cbc:ID>
    <cbc:DocumentDescription>${data.typeTransaction}</cbc:DocumentDescription>
  </cac:AdditionalDocumentReference>`
            : ''
        }${
          data.optionTVA
            ? `
  <cac:AdditionalDocumentReference>
    <cbc:ID>OptionTVA</cbc:ID>
    <cbc:DocumentDescription>${data.optionTVA}</cbc:DocumentDescription>
  </cac:AdditionalDocumentReference>`
            : ''
        }`
      : '';

  // BT-10 : référence acheteur (code de routage Peppol).
  // Priorité : valeur saisie, sinon orderReference (BT-13), sinon fallback calculé.
  const effectiveBuyerReference =
    data.buyerReference?.trim() || data.orderReference?.trim() || `REF-${data.invoiceNumber}`;

  // BT-72 — date de livraison / fin de prestation.
  // Structure extensible : accueillera plus tard cac:DeliveryLocation/cac:Address (BG-15,
  // adresse de livraison « Ship to ») — HORS PÉRIMÈTRE de cette passe.
  const deliveryBlock = data.deliveryDate
    ? `
  <cac:Delivery>
    <cbc:ActualDeliveryDate>${data.deliveryDate}</cbc:ActualDeliveryDate>
  </cac:Delivery>`
    : '';

  // BT-6 — code de la devise de comptabilisation TVA (émis seulement si ≠ devise facture).
  const taxCurrencyCodeBlock = needsTaxCurrency
    ? `
  <cbc:TaxCurrencyCode>${data.taxCurrency}</cbc:TaxCurrencyCode>`
    : '';

  // BT-111 — second cac:TaxTotal portant uniquement le montant de TVA converti dans la
  // devise de comptabilisation (émis seulement si ≠ devise facture).
  const taxTotalTaxCurrencyBlock = needsTaxCurrency
    ? `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.taxCurrency}">${fmt(taxTotalInTaxCurrency)}</cbc:TaxAmount>
  </cac:TaxTotal>`
    : '';

  // BG-20/21 — remises/charges au niveau document, après PaymentMeans/PaymentTerms et
  // avant cac:TaxTotal (ordre UBL). Chaque entrée porte sa cac:TaxCategory.
  const documentAllowanceChargeBlock = (data.documentAllowanceCharges ?? [])
    .map((ac) => renderAllowanceCharge(ac, true).replace(/\n {4}/g, '\n  '))
    .join('');

  // BG-1 / BT-21-22 — mentions structurées. Une note avec un code sujet UNTDID 4451 confirmé
  // est émise selon la convention EN16931-UBL « CODE#texte » dans cbc:Note ; sinon texte seul.
  const notesBlock = resolveNotes(data)
    .map((n) => {
      const code = n.subjectCode?.trim().toUpperCase();
      const value = isConfirmedNoteSubjectCode(code) ? `${code}#${n.text}` : n.text;
      return `
  <cbc:Note>${escapeXml(value)}</cbc:Note>`;
    })
    .join('');

  // BG-10 / BT-59-61 — partie bénéficiaire du paiement (cac:PayeeParty), placée après
  // cac:AccountingCustomerParty et avant cac:Delivery (ordre UBL Invoice). Le compte de
  // règlement (IBAN) reste celui de PaymentMeans (pour l'affacturage : IBAN du factor).
  const payeeBlock = data.payee?.name?.trim()
    ? `
  <cac:PayeeParty>${
    data.payee.identifier?.trim()
      ? `
    <cac:PartyIdentification>
      <cbc:ID>${escapeXml(data.payee.identifier.trim())}</cbc:ID>
    </cac:PartyIdentification>`
      : ''
  }
    <cac:PartyName>
      <cbc:Name>${escapeXml(data.payee.name.trim())}</cbc:Name>
    </cac:PartyName>${
      data.payee.legalId?.trim()
        ? `
    <cac:PartyLegalEntity>
      <cbc:CompanyID>${escapeXml(data.payee.legalId.trim())}</cbc:CompanyID>
    </cac:PartyLegalEntity>`
        : ''
    }
  </cac:PayeeParty>`
    : '';

  // BT-107 / BT-108 — émis dans LegalMonetaryTotal seulement si non nuls.
  const allowanceTotalLine =
    allowanceTotal > 0
      ? `
    <cbc:AllowanceTotalAmount currencyID="${data.currency}">${fmt(allowanceTotal)}</cbc:AllowanceTotalAmount>`
      : '';
  const chargeTotalLine =
    chargeTotal > 0
      ? `
    <cbc:ChargeTotalAmount currencyID="${data.currency}">${fmt(chargeTotal)}</cbc:ChargeTotalAmount>`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootTag} xmlns="${xmlns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ccts="urn:un:unece:uncefact:documentation:2" xmlns:qdt="urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2" xmlns:udt="urn:oasis:names:specification:ubl:schema:xsd:UnqualifiedDataTypes-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>${cadre.code}</cbc:ProfileID>
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${data.invoiceDate}</cbc:IssueDate>${
    dueDateEmitted
      ? `
  <cbc:DueDate>${dueDateEmitted}</cbc:DueDate>`
      : ''
  }
  <${typeCodeTag}>${typeCode}</${typeCodeTag}>${notesBlock}
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>${taxCurrencyCodeBlock}
  <cbc:AccountingCost>FRAIS-GESTION-CLASSE6</cbc:AccountingCost>
  <cbc:BuyerReference>${escapeXml(effectiveBuyerReference)}</cbc:BuyerReference>${orderReferenceBlock}${billingReferenceBlock}${cisuFrBlocks}

  <cac:AccountingSupplierParty>
    <cac:Party>${supplierEndpoint}
      <cac:PartyName>
        <cbc:Name>${escapeXml(data.supplier.name)}</cbc:Name>
      </cac:PartyName>${supplierAddress}${supplierTaxScheme}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(data.supplier.name)}</cbc:RegistrationName>${supplierSiret}${
          data.supplier.legalForm
            ? `
        <cbc:CompanyLegalForm>${escapeXml(data.supplier.legalForm)}</cbc:CompanyLegalForm>`
            : ''
        }
      </cac:PartyLegalEntity>${supplierContact}
    </cac:Party>
  </cac:AccountingSupplierParty>

  <cac:AccountingCustomerParty>
    <cac:Party>${buyerEndpoint}
      <cac:PartyName>
        <cbc:Name>${escapeXml(buyerName)}</cbc:Name>
      </cac:PartyName>${buyerAddressBlock}${buyerTaxScheme}${buyerLegalEntity}
    </cac:Party>
  </cac:AccountingCustomerParty>
${payeeBlock}${deliveryBlock}${paymentMeans}${documentAllowanceChargeBlock}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${fmt(totalTax)}</cbc:TaxAmount>${taxSubtotals}
  </cac:TaxTotal>${taxTotalTaxCurrencyBlock}

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(lineExtensionTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${data.currency}">${fmt(taxExclusiveAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${data.currency}">${fmt(taxInclusiveAmount)}</cbc:TaxInclusiveAmount>${allowanceTotalLine}${chargeTotalLine}
    <cbc:PrepaidAmount currencyID="${data.currency}">${fmt(prepaidEmitted)}</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${fmt(payableAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${invoiceLines}
</${rootTag}>`;
}

// ─── Génération PDF professionnel ─────────────────────────────────────────────

function writePdf(
  data: InvoiceGenData,
  computed: ComputedAmounts,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 45, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // BT-23 — cadre de facturation (lettre B/S/M + chiffre 1/2/4).
    const cadre = computeCadre(data);
    // BR-FR-CO-09 — facture déjà payée (cadre chiffre 2) : net à payer nul, date de paiement BT-9.
    const isPaidFrame = cadre.digit === '2';
    const paymentDateStr = data.paymentDate ?? data.invoiceDate;

    const fmt = (n: number) => n.toFixed(2) + ' ' + data.currency;
    const PAGE_W = 595 - 90; // largeur utile (A4 - marges)
    const LEFT = 45;
    const RIGHT = 550;

    // ── Bande titre ──────────────────────────────────────────────────────────
    doc.rect(LEFT - 5, 35, PAGE_W + 10, 30).fill('#1e3a5f');
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text('FACTURE FOURNISSEUR', LEFT, 43, { align: 'center', width: PAGE_W });
    doc.fillColor('#000000');

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#888888')
      .text('Document de test généré — sans valeur comptable', LEFT, 70, {
        align: 'center',
        width: PAGE_W,
      });
    doc.fillColor('#000000');

    doc.moveDown(0.5);
    const y = doc.y;

    // ── Bloc fournisseur (gauche) et informations facture (droite) ────────────
    const COL_L = LEFT;
    const COL_R = LEFT + PAGE_W / 2 + 10;

    // Fournisseur
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f').text('FOURNISSEUR', COL_L, y);
    doc.fillColor('#000000').font('Helvetica');
    let yF = y + 13;
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .text(data.supplier.name, COL_L, yF, { width: PAGE_W / 2 });
    yF = doc.y;
    doc.fontSize(8).font('Helvetica');
    if (data.supplier.legalForm) {
      doc.text(data.supplier.legalForm, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    if (data.supplier.address) {
      doc.text(data.supplier.address, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    const cityLine = [data.supplier.postalCode, data.supplier.city].filter(Boolean).join(' ');
    if (cityLine) {
      doc.text(cityLine, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    if (data.supplier.siret) {
      doc.text(`SIRET : ${data.supplier.siret}`, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    if (data.supplier.taxId) {
      doc.text(`TVA   : ${data.supplier.taxId}`, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    if (data.supplier.phone) {
      doc.text(`Tél.  : ${data.supplier.phone}`, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }
    if (data.supplier.email) {
      doc.text(`Email : ${data.supplier.email}`, COL_L, yF, { width: PAGE_W / 2 });
      yF = doc.y;
    }

    // En-tête facture (droite)
    const yR = y;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f').text('FACTURE', COL_R, yR);
    doc.fillColor('#000000').font('Helvetica').fontSize(8);
    let yRr = yR + 13;

    const infoRows: [string, string][] = [
      ['Numéro', data.invoiceNumber],
      ["Date d'émission", data.invoiceDate],
      [
        isPaidFrame ? 'Payée le' : "Date d'échéance",
        isPaidFrame ? paymentDateStr : (data.dueDate ?? '—'),
      ],
      ['Devise', data.currency],
      ['Type', directionLabel(data.direction)],
      ['Cadre (BT-23)', cadre.label],
    ];
    for (const [label, value] of infoRows) {
      doc.font('Helvetica-Bold').text(`${label} :`, COL_R, yRr, { width: 90, continued: false });
      doc.font('Helvetica').text(value, COL_R + 92, yRr, { width: PAGE_W / 2 - 95 });
      yRr = doc.y;
    }

    // BT-3 — référence à la facture corrigée (TypeCode 384)
    if (data.correctedInvoiceRef) {
      doc
        .font('Helvetica-Bold')
        .text('Corrige la facture :', COL_R, yRr, { width: 90, continued: false });
      doc
        .font('Helvetica')
        .text(data.correctedInvoiceRef, COL_R + 92, yRr, { width: PAGE_W / 2 - 95 });
      yRr = doc.y;
    }

    // Acheteur (droite, en dessous) — BT-44 à BT-56 CIUS-FR
    yRr += 6;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a5f').text('ACHETEUR', COL_R, yRr);
    yRr += 13;
    doc
      .fillColor('#000000')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(data.buyerName ?? 'DEMO INDUSTRIE SAS', COL_R, yRr, { width: PAGE_W / 2 });
    yRr = doc.y;
    doc.font('Helvetica');
    if (data.buyerLegalForm) {
      doc.text(data.buyerLegalForm, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }
    if (data.buyerAddress) {
      doc.text(data.buyerAddress, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }
    const buyerCityLine = [data.buyerPostalCode, data.buyerCity].filter(Boolean).join(' ');
    if (buyerCityLine) {
      doc.text(buyerCityLine, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }
    if (data.buyerCountry && data.buyerCountry.toUpperCase() !== 'FR') {
      doc.text(data.buyerCountry, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }
    if (data.buyerSiret) {
      doc.text(`SIRET : ${data.buyerSiret}`, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }
    if (data.buyerVatNumber) {
      doc.text(`TVA   : ${data.buyerVatNumber}`, COL_R, yRr, { width: PAGE_W / 2 });
      yRr = doc.y;
    }

    // BG-10 / BT-59-61 — bénéficiaire / factor (cac:PayeeParty), affiché sous l'acheteur.
    if (data.payee?.name?.trim()) {
      yRr += 6;
      doc
        .fontSize(8)
        .font('Helvetica-Bold')
        .fillColor('#1e3a5f')
        .text('BÉNÉFICIAIRE / FACTOR', COL_R, yRr);
      yRr += 11;
      const payeeId = [data.payee.identifier, data.payee.legalId].filter(Boolean).join(' / ');
      doc
        .fillColor('#000000')
        .font('Helvetica')
        .fontSize(8)
        .text(`${data.payee.name}${payeeId ? ` (${payeeId})` : ''}`, COL_R, yRr, {
          width: PAGE_W / 2,
        });
      yRr = doc.y;
    }

    // Ligne de séparation
    const yAfterHeader = Math.max(yF, doc.y) + 12;
    doc
      .moveTo(LEFT - 5, yAfterHeader)
      .lineTo(RIGHT + 5, yAfterHeader)
      .strokeColor('#1e3a5f')
      .lineWidth(1.5)
      .stroke();
    doc.lineWidth(1);
    let tableY = yAfterHeader + 10;

    // ── Bloc RÉFÉRENCES + marqueurs CIUS-FR ───────────────────────────────────
    // BT-10 : même logique que le XML — saisie, sinon BT-13, sinon fallback calculé.
    const effectiveBuyerReference =
      data.buyerReference?.trim() || data.orderReference?.trim() || `REF-${data.invoiceNumber}`;
    const refRows: [string, string][] = [];
    refRows.push(['Code de routage (BT-10)', effectiveBuyerReference]);
    if (data.orderReference) {
      refRows.push(['Bon de commande (BT-13)', data.orderReference]);
    }
    if (data.salesOrderId) {
      refRows.push(['Référence vendeur (BT-14)', data.salesOrderId]);
    }
    if (data.deliveryDate) {
      refRows.push(['Date de livraison (BT-72)', data.deliveryDate]);
    }
    if (data.typeTransaction) {
      const labels: Record<'1' | '2' | '3', string> = {
        '1': 'Biens',
        '2': 'Services',
        '3': 'Mixte',
      };
      refRows.push([
        'Type de transaction (CIUS-FR)',
        `${data.typeTransaction} — ${labels[data.typeTransaction]}`,
      ]);
    }
    if (data.optionTVA) {
      const labels: Record<'S' | 'E', string> = {
        S: 'Sur les débits',
        E: 'Sur les encaissements',
      };
      refRows.push(['Option TVA (CIUS-FR)', `${data.optionTVA} — ${labels[data.optionTVA]}`]);
    }
    // BT-34/BT-49 — mention discrète si l'EndpointID n'a pu être émis (non routable Peppol).
    if (!computePeppolRoutable(data)) {
      refRows.push(['Routage Peppol', 'non applicable (voie PPF)']);
    }

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e3a5f').text('RÉFÉRENCES', LEFT, tableY);
    tableY += 11;
    doc.fillColor('#000000').fontSize(7.5);
    for (const [label, value] of refRows) {
      doc.font('Helvetica-Bold').text(`${label} :`, LEFT, tableY, { width: 180 });
      doc.font('Helvetica').text(value, LEFT + 182, tableY, { width: PAGE_W - 182 });
      tableY = doc.y + 1;
    }
    tableY += 6;

    // ── En-tête tableau ───────────────────────────────────────────────────────
    // Colonnes sans compte comptable (info interne non présente sur une vraie facture fournisseur)
    const COL = {
      desc: LEFT,
      qty: LEFT + 265,
      pu: LEFT + 315,
      ht: LEFT + 375,
      tva: LEFT + 435,
      ttc: LEFT + 470,
    };

    doc.rect(LEFT - 5, tableY - 2, PAGE_W + 10, 16).fill('#eef2f7');
    doc.fillColor('#1e3a5f').fontSize(7).font('Helvetica-Bold');
    doc.text('Description', COL.desc, tableY, { width: 258 });
    doc.text('Qté', COL.qty, tableY, { width: 46, align: 'right' });
    doc.text('P.U. HT', COL.pu, tableY, { width: 57, align: 'right' });
    doc.text('HT', COL.ht, tableY, { width: 55, align: 'right' });
    doc.text('TVA', COL.tva, tableY, { width: 30, align: 'right' });
    doc.text('TTC', COL.ttc, tableY, { width: 55, align: 'right' });
    tableY += 18;

    // ── Lignes ────────────────────────────────────────────────────────────────
    doc.fillColor('#000000').fontSize(7).font('Helvetica');
    let stripe = false;
    for (const line of computed.computedLines) {
      if (stripe)
        doc
          .rect(LEFT - 5, tableY - 1, PAGE_W + 10, 13)
          .fill('#f8fafc')
          .fillColor('#000000');
      stripe = !stripe;
      const rowY = tableY;
      doc.text(line.description.substring(0, 48), COL.desc, rowY, { width: 258 });
      doc
        .text(String(line.quantity), COL.qty, rowY, { width: 46, align: 'right' })
        .text(line.unitPrice.toFixed(2), COL.pu, rowY, { width: 57, align: 'right' })
        .text(line.amountExclTax.toFixed(2), COL.ht, rowY, { width: 55, align: 'right' })
        .text(`${line.taxRate}%`, COL.tva, rowY, { width: 30, align: 'right' })
        .text(line.amountInclTax.toFixed(2), COL.ttc, rowY, { width: 55, align: 'right' });
      tableY += 14;
      // BG-27/28 — remises/charges de ligne (affichées sous la ligne concernée).
      for (const ac of line.allowanceCharges ?? []) {
        const sign = ac.isCharge ? '+' : '−';
        const label = ac.isCharge ? 'Charge' : 'Remise';
        const motif = [ac.reason, ac.reasonCode ? `(${ac.reasonCode})` : '']
          .filter(Boolean)
          .join(' ');
        doc
          .fillColor('#666666')
          .fontSize(6.5)
          .text(
            `    ${label} : ${sign}${ac.amount.toFixed(2)} ${data.currency}${motif ? ` — ${motif}` : ''}`,
            COL.desc,
            tableY,
            { width: PAGE_W },
          );
        tableY = doc.y + 1;
        doc.fillColor('#000000').fontSize(7);
      }
    }

    doc
      .moveTo(LEFT - 5, tableY)
      .lineTo(RIGHT + 5, tableY)
      .strokeColor('#cccccc')
      .lineWidth(0.5)
      .stroke();
    doc.lineWidth(1);
    tableY += 8;

    // ── Récapitulatif TVA par (catégorie + taux) ─────────────────────────────
    // Base par catégorie (BT-116/117) incluant les remises/charges document.
    const pdfTaxGroups = computed.taxCategories;

    const catLabels: Record<string, string> = {
      S: 'Standard',
      Z: 'Taux zéro',
      E: 'Exonéré',
      AE: 'Autoliquidation',
      K: 'Exonération intra-EEE',
      G: 'Export hors UE',
      O: 'Hors champ TVA',
    };

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e3a5f').text('TVA', LEFT, tableY);
    tableY += 10;
    doc.font('Helvetica').fillColor('#000000').fontSize(7);
    for (const g of pdfTaxGroups) {
      const catLabel = catLabels[g.cat] ?? g.cat;
      doc
        .font('Helvetica')
        .text(
          `TVA ${g.rate}% [${g.cat} — ${catLabel}] — Base : ${g.taxable.toFixed(2)} — TVA : ${g.tax.toFixed(2)} ${data.currency}`,
          LEFT,
          tableY,
          { width: PAGE_W },
        );
      tableY += 10;
      // Mention/motif imprimé pour toutes les catégories exonérées ou autoliquidées
      // (E, AE, K, G, O). Pour AE, on auto-complète la mention « Autoliquidation »
      // (VATEX-FR-AE) si aucun motif explicite n'a été saisi — cohérent avec le XML.
      const EXEMPT_CATS = ['E', 'AE', 'K', 'G', 'O'];
      if (EXEMPT_CATS.includes(g.cat)) {
        let exReason = g.exemptionReason;
        let exCode = g.exemptionCode;
        if (g.cat === 'AE') {
          exCode = exCode || 'VATEX-FR-AE';
          exReason = exReason || 'Autoliquidation';
        }
        if (exReason || exCode) {
          const parts: string[] = [];
          if (exReason) parts.push(exReason);
          if (exCode) parts.push(`(${exCode})`);
          const label = g.cat === 'AE' ? 'Mention' : "Motif d'exonération";
          doc
            .fillColor('#666666')
            .fontSize(6.5)
            .text(`    ${label} : ${parts.join(' ')}`, LEFT, tableY, {
              width: PAGE_W,
            });
          tableY = doc.y + 1;
          doc.fillColor('#000000').fontSize(7);
        }
      }
    }

    // BT-6/BT-111 — total TVA dans la devise de comptabilisation (si ≠ devise facture)
    if (data.taxCurrency && data.taxCurrency !== data.currency && data.taxExchangeRate != null) {
      const taxInTaxCur = round2(computed.totalTax * data.taxExchangeRate);
      doc
        .font('Helvetica')
        .fillColor('#000000')
        .fontSize(7)
        .text(
          `Total TVA (devise de comptabilisation) : ${taxInTaxCur.toFixed(2)} ${data.taxCurrency} ` +
            `(taux ${data.taxExchangeRate})`,
          LEFT,
          tableY,
          { width: PAGE_W },
        );
      tableY = doc.y + 1;
    }
    tableY += 4;

    // ── Totaux ────────────────────────────────────────────────────────────────
    const TOT_L = COL_R;
    const TOT_W = PAGE_W - (COL_R - LEFT);

    doc.fontSize(8).font('Helvetica').fillColor('#333333');
    const totalY = tableY;
    let totRowY = totalY;
    const totRow = (label: string, value: string, opts?: { bold?: boolean }) => {
      doc.font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, TOT_L, totRowY, { width: TOT_W - 70 });
      doc.text(value, TOT_L + TOT_W - 70, totRowY, { width: 70, align: 'right' });
      totRowY += 12;
    };

    // BT-107 / BT-108 — totaux remises/charges document (affichés si non nuls),
    // au-dessus du HT net (BT-109).
    if (computed.allowanceTotal > 0 || computed.chargeTotal > 0) {
      totRow('Total HT lignes', fmt(computed.lineExtensionTotal));
      if (computed.allowanceTotal > 0) totRow('Total remises', `-${fmt(computed.allowanceTotal)}`);
      if (computed.chargeTotal > 0) totRow('Total charges', `+${fmt(computed.chargeTotal)}`);
    }
    totRow('Total HT', fmt(computed.taxExclusiveAmount));
    totRow('TVA totale', fmt(computed.totalTax));

    const ttcBoxY = totRowY + 2;
    doc.rect(TOT_L - 4, ttcBoxY, TOT_W + 8, 18).fill('#1e3a5f');
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text('TOTAL TTC', TOT_L, ttcBoxY + 4, { width: TOT_W - 75 });
    doc.text(fmt(computed.taxInclusiveAmount), TOT_L + TOT_W - 75, ttcBoxY + 4, {
      width: 75,
      align: 'right',
    });
    doc.fillColor('#000000');

    // ── Net à payer ───────────────────────────────────────────────────────────
    if (isPaidFrame) {
      // BR-FR-CO-09 — facture déjà payée (cadre chiffre 2) : payé = TTC, net à payer = 0.
      const paidLabelY = doc.y + 4;
      doc
        .fontSize(8)
        .font('Helvetica')
        .text(`Facture payée le ${paymentDateStr}`, TOT_L, paidLabelY, { width: TOT_W });
      const paidY = doc.y + 1;
      doc
        .fontSize(8)
        .font('Helvetica')
        .text('Payé :', TOT_L, paidY, { width: TOT_W - 70 })
        .text(`-${fmt(computed.taxInclusiveAmount)}`, TOT_L + TOT_W - 70, paidY, {
          width: 70,
          align: 'right',
        });
      const payableY = doc.y + 2;
      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('Net à payer :', TOT_L, payableY, { width: TOT_W - 75 })
        .text(fmt(computed.payableAmount), TOT_L + TOT_W - 75, payableY, {
          width: 75,
          align: 'right',
        });
    } else if ((data.prepaidAmount ?? 0) > 0) {
      // ── Acompte versé déduit (BT-113) — cadre chiffre 4 ─────────────────────
      const payable = computed.payableAmount;
      const acompteY = doc.y + 4;
      doc
        .fontSize(8)
        .font('Helvetica')
        .text('Acompte versé :', TOT_L, acompteY, { width: TOT_W - 70 })
        .text(`-${fmt(data.prepaidAmount!)}`, TOT_L + TOT_W - 70, acompteY, {
          width: 70,
          align: 'right',
        });
      const payableY = doc.y + 2;
      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('Net à payer :', TOT_L, payableY, { width: TOT_W - 75 })
        .text(fmt(payable), TOT_L + TOT_W - 75, payableY, {
          width: 75,
          align: 'right',
        });
    }

    // ── Paiement ──────────────────────────────────────────────────────────────
    const payY = Math.max(tableY + 55, doc.y + 14);
    doc
      .moveTo(LEFT - 5, payY)
      .lineTo(RIGHT + 5, payY)
      .strokeColor('#1e3a5f')
      .lineWidth(1)
      .stroke();
    const payY2 = payY + 8;
    doc
      .fontSize(7.5)
      .font('Helvetica-Bold')
      .fillColor('#1e3a5f')
      .text('CONDITIONS DE PAIEMENT', LEFT, payY2);
    doc.fillColor('#000000').font('Helvetica').fontSize(7.5);
    let pyy = payY2 + 12;
    doc.text(
      'Paiement à 30 jours net. Tout retard de paiement engendre des pénalités égales à 3 fois le taux légal + indemnité forfaitaire de 40 €.',
      LEFT,
      pyy,
      { width: PAGE_W },
    );
    pyy = doc.y + 5;
    if (data.supplier.iban) {
      doc.font('Helvetica-Bold').text(`IBAN : ${data.supplier.iban}`, LEFT, pyy, { width: PAGE_W });
      pyy = doc.y;
      if (data.supplier.bic) {
        doc.font('Helvetica').text(`BIC  : ${data.supplier.bic}`, LEFT, pyy, { width: PAGE_W });
        pyy = doc.y;
      }
    }

    // BG-1 / BT-21-22 — mentions structurées (code sujet affiché entre crochets si présent).
    const pdfNotes = resolveNotes(data);
    if (pdfNotes.length) {
      pyy += 6;
      doc.font('Helvetica').fillColor('#555555');
      for (const n of pdfNotes) {
        const prefix = n.subjectCode?.trim() ? `[${n.subjectCode.trim().toUpperCase()}] ` : '';
        doc.text(`Note : ${prefix}${n.text}`, LEFT, pyy, { width: PAGE_W });
        pyy = doc.y + 1;
      }
    }

    // ── Pied de page ──────────────────────────────────────────────────────────
    // Positionnement conditionnel pour éviter la page blanche : on calcule un y
    // qui reste dans la zone imprimable et on désactive le saut de ligne auto.
    const bottomMargin = doc.page.margins.bottom ?? 45;
    const footerY = Math.min(Math.max(doc.y + 8, 760), doc.page.height - bottomMargin - 10);
    doc
      .fontSize(6)
      .fillColor('#aaaaaa')
      .text(
        'Mode frais de gestion — factures fournisseurs classe 6 uniquement — Document de test généré par BILLING Invoice Generator',
        LEFT,
        footerY,
        { width: PAGE_W, align: 'center', lineBreak: false },
      );

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ─── Création ZIP (STORE, sans dépendance externe) ────────────────────────────

function crc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipBuffer(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;
    const modTime = 0x0000;
    const modDate = 0x0000;

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression: STORE
    local.writeUInt16LE(modTime, 10);
    local.writeUInt16LE(modDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);

    // Central directory entry
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // STORE
    central.writeUInt16LE(modTime, 12);
    central.writeUInt16LE(modDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    locals.push(local, file.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ─── Entrée principale ────────────────────────────────────────────────────────

export async function generateAndSave(data: InvoiceGenData): Promise<GeneratedInvoice> {
  // Validation bloquante : toutes les lignes doivent avoir un compte classe 6
  validateExpenseLines(data.lines);

  const xmlContent = generateUblXml(data);
  const computed = computeAmountsForData(data);
  const cadre = computeCadre(data);
  const dir = getGeneratedDir();
  const xmlFilename = buildFilename(data.invoiceNumber, 'xml');
  const pdfFilename = buildFilename(data.invoiceNumber, 'pdf');
  const zipFilename = buildFilename(data.invoiceNumber, 'zip');

  const xmlPath = path.join(dir, xmlFilename);
  const pdfPath = path.join(dir, pdfFilename);
  const zipPath = path.join(dir, zipFilename);

  fs.writeFileSync(xmlPath, xmlContent, 'utf-8');
  await writePdf(data, computed, pdfPath);

  const safeInvoiceNum = data.invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 40);
  const safeSupplier = data.supplier.name.replace(/[^a-zA-Z0-9\-_]/g, '_').substring(0, 20);
  const zipXmlName = `INV_${safeInvoiceNum}_${safeSupplier}.xml`;
  const zipPdfName = `INV_${safeInvoiceNum}_${safeSupplier}.pdf`;

  const zipBuffer = createZipBuffer([
    { name: zipXmlName, data: Buffer.from(xmlContent, 'utf-8') },
    { name: zipPdfName, data: fs.readFileSync(pdfPath) },
  ]);
  fs.writeFileSync(zipPath, zipBuffer);

  return {
    xmlContent,
    xmlFilename,
    pdfFilename,
    zipFilename,
    summary: {
      invoiceNumber: data.invoiceNumber,
      direction: data.direction,
      supplierName: data.supplier.name,
      supplierIdentifier: data.supplier.taxId ?? data.supplier.siret ?? 'UNKNOWN',
      totalExclTax: computed.taxExclusiveAmount,
      totalTax: computed.totalTax,
      totalInclTax: computed.totalInclTax,
      prepaidAmount: computed.prepaidAmount,
      payableAmount: computed.payableAmount,
      currency: data.currency,
      lineCount: data.lines.length,
      cadreCode: cadre.code,
      cadreLabel: cadre.label,
      cadreWarning: cadreDivergenceWarning(cadre),
      peppolRoutable: computePeppolRoutable(data),
    },
  };
}

export function getGeneratedFilePath(filename: string): string {
  const dir = getGeneratedDir();
  const safe = path.basename(filename); // anti path-traversal
  return path.join(dir, safe);
}

// ─── Enrichissement fournisseur ───────────────────────────────────────────────

export async function enrichFromPappers(siren: string): Promise<SupplierEnrichment | null> {
  const apiKey = process.env.PAPPERS_API ?? process.env.PAPPERS_API_KEY;
  const baseUrl = (process.env.PAPPERS_URL ?? 'https://api.pappers.fr/v2/').replace(/\/$/, '');
  if (!apiKey) return null;

  const url = `${baseUrl}/entreprise?api_token=${encodeURIComponent(apiKey)}&siren=${encodeURIComponent(siren)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;

  const body = (await res.json()) as Record<string, unknown>;
  const siege = body.siege as Record<string, unknown> | undefined;

  const name = String(body.nom_entreprise ?? body.denomination ?? '').trim();
  if (!name) return null;

  return {
    name,
    address: siege
      ? String(siege.adresse_ligne_1 ?? siege.voie ?? '').trim() || undefined
      : undefined,
    city: siege ? String(siege.ville ?? '').trim() || undefined : undefined,
    postalCode: siege ? String(siege.code_postal ?? '').trim() || undefined : undefined,
    country: 'FR',
    taxId: body.numero_tva_intracommunautaire
      ? String(body.numero_tva_intracommunautaire).trim()
      : undefined,
    siret: siege ? String(siege.siret ?? '').trim() || undefined : undefined,
    source: 'PAPPERS',
  };
}

export async function enrichFromInsee(siren: string): Promise<SupplierEnrichment | null> {
  // L'API Sirene v3 utilise désormais X-INSEE-Api-Key-Integration (OAuth2 déprécié depuis 2024)
  const apiKey = process.env.INSEE_CONSUMER_KEY ?? process.env.INSEE_API_KEY;
  if (!apiKey) return null;

  const sirenRes = await fetch(
    `https://api.insee.fr/api-sirene/3.11/siren/${encodeURIComponent(siren)}`,
    {
      headers: { 'X-INSEE-Api-Key-Integration': apiKey },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!sirenRes.ok) return null;

  const data = (await sirenRes.json()) as Record<string, unknown>;
  const unite = data.uniteLegale as Record<string, unknown> | undefined;
  const periodes = unite?.periodesUniteLegale as Record<string, unknown>[] | undefined;
  const last = periodes?.[0] ?? {};

  const nom = String(
    last.denominationUniteLegale ??
      `${last.prenomUsuelUniteLegale ?? ''} ${last.nomUniteLegale ?? ''}`.trim(),
  ).trim();

  return {
    name: nom || siren,
    country: 'FR',
    source: 'INSEE',
  };
}

export async function enrichSupplier(siren: string): Promise<SupplierEnrichment | null> {
  try {
    const pappers = await enrichFromPappers(siren);
    if (pappers?.name) return pappers;
  } catch {
    // Pappers indisponible, on essaie INSEE
  }
  try {
    return await enrichFromInsee(siren);
  } catch {
    return null;
  }
}
