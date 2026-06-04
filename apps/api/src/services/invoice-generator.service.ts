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
  direction:
    | 'INVOICE'
    | 'CREDIT_NOTE'
    | 'ADVANCE_INVOICE'
    | 'CORRECTIVE_INVOICE'
    | 'ADVANCE_CREDIT_NOTE';
  prepaidAmount?: number; // BT-113 — montant acompte déjà versé (0 ou absent = aucun)
  // Statut de paiement à l'émission — pilote le chiffre 1 (non payée) vs 2 (déjà payée)
  // du cadre de facturation BT-23. Défaut : 'unpaid'.
  paymentStatus?: 'unpaid' | 'paid';
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
  note?: string;
}

export interface ComputedLine extends InvoiceGenLine {
  lineNo: number;
  amountExclTax: number;
  taxAmount: number;
  amountInclTax: number;
}

export interface ComputedAmounts {
  computedLines: ComputedLine[];
  totalExclTax: number;
  totalTax: number;
  totalInclTax: number;
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
    default:
      return '380';
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

  // Chiffre : 4 réservé à la facture définitive après acompte (BT-3=380 + acompte > 0).
  // Les avoirs (381/503), la rectificative (384) et l'acompte (386) ne produisent JAMAIS 4
  // (BR-FR-CO-08). Sinon : 2 si déjà payée à l'émission, 1 sinon.
  const prepaid = data.prepaidAmount ?? 0;
  const paid = data.paymentStatus === 'paid';
  const digit: CadreDigit = typeCode === '380' && prepaid > 0 ? '4' : paid ? '2' : '1';

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
// (docs.peppol.eu/poacc/billing/3.0/codelist/eas/). Le préfixe TVA grec est « EL »
// (mais correspond au code GR 9933). On NE met JAMAIS 9957 (FR:VAT) pour un
// identifiant non français.
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
  HR: '9934',
  IE: '9935',
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

function vatEasScheme(vat: string): string | null {
  const prefix = vat.trim().slice(0, 2).toUpperCase();
  return VAT_EAS_BY_PREFIX[prefix] ?? null;
}

// Construit l'élément cbc:EndpointID (BT-34/BT-49). Priorité au SIRET (scheme 0009).
// À défaut, l'identifiant TVA reçoit le scheme EAS de son pays ; si le préfixe est
// inconnu/non standard (ex. OSS « EU… »), on émet l'EndpointID SANS scheme erroné,
// précédé d'un commentaire TODO — plutôt qu'un faux 9957.
function buildEndpointId(siret?: string, vat?: string): string {
  if (siret) {
    return `
      <cbc:EndpointID schemeID="0009">${escapeXml(siret)}</cbc:EndpointID>`;
  }
  if (vat) {
    const scheme = vatEasScheme(vat);
    if (scheme) {
      return `
      <cbc:EndpointID schemeID="${scheme}">${escapeXml(vat)}</cbc:EndpointID>`;
    }
    return `
      <!-- TODO EAS scheme à confirmer pour le préfixe TVA "${escapeXml(vat.trim().slice(0, 2))}" -->
      <cbc:EndpointID>${escapeXml(vat)}</cbc:EndpointID>`;
  }
  return '';
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

// ─── Calcul des montants ──────────────────────────────────────────────────────

export function computeAmounts(lines: InvoiceGenLine[]): ComputedAmounts {
  let totalExclTax = 0;
  let totalTax = 0;

  const computedLines: ComputedLine[] = lines.map((line, idx) => {
    const amountExclTax = round2(line.quantity * line.unitPrice);
    const taxAmount = round2((amountExclTax * line.taxRate) / 100);
    const amountInclTax = round2(amountExclTax + taxAmount);
    totalExclTax += amountExclTax;
    totalTax += taxAmount;
    return { ...line, lineNo: idx + 1, amountExclTax, taxAmount, amountInclTax };
  });

  return {
    computedLines,
    totalExclTax: round2(totalExclTax),
    totalTax: round2(totalTax),
    totalInclTax: round2(totalExclTax + totalTax),
  };
}

// ─── Génération XML UBL 2.1 ──────────────────────────────────────────────────

export function generateUblXml(data: InvoiceGenData): string {
  const { computedLines, totalExclTax, totalTax, totalInclTax } = computeAmounts(data.lines);

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

  // BT-23 — cadre de facturation (porté par cbc:ProfileID, code court ex. « S1 »).
  const cadre = computeCadre(data);

  const fmt = (n: number) => n.toFixed(2);
  const fmt4 = (n: number) => n.toFixed(4);

  const taxCatCode = (line: ComputedLine): string => {
    if (line.taxCategoryCode) return line.taxCategoryCode;
    return line.taxRate === 0 ? 'Z' : 'S';
  };

  // Regroupement TVA par (catégorie + taux + code exonération) pour TaxTotal/TaxSubtotal
  interface TaxGroup {
    rate: number;
    cat: string;
    taxable: number;
    tax: number;
    exemptionCode?: string;
    exemptionReason?: string;
  }
  const taxGroups = new Map<string, TaxGroup>();
  for (const line of computedLines) {
    const cat = taxCatCode(line);
    const exCode = line.taxExemptionReasonCode ?? '';
    const exReason = line.taxExemptionReason ?? '';
    const key = `${cat}_${line.taxRate}_${exCode}_${exReason}`;
    const g = taxGroups.get(key) ?? {
      rate: line.taxRate,
      cat,
      taxable: 0,
      tax: 0,
      exemptionCode: line.taxExemptionReasonCode,
      exemptionReason: line.taxExemptionReason,
    };
    taxGroups.set(key, {
      ...g,
      taxable: round2(g.taxable + line.amountExclTax),
      tax: round2(g.tax + line.taxAmount),
    });
  }

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

  const taxSubtotals = Array.from(taxGroups.values())
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

  // InvoiceLine avec cbc:AccountingCost (champ UBL 2.1 standard pour référence comptable acheteur)
  const invoiceLines = computedLines
    .map((line) => {
      const unitCode = line.unitCode ?? 'C62';
      const cat = taxCatCode(line);
      const itemName = line.name ?? line.description;
      const accCost = line.accountingCode
        ? `\n    <cbc:AccountingCost>${escapeXml(line.accountingCode)}</cbc:AccountingCost>`
        : '';
      return `
  <cac:${lineTag}>
    <cbc:ID>${line.lineNo}</cbc:ID>
    <${qtyTag} unitCode="${unitCode}">${fmt4(line.quantity)}</${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(line.amountExclTax)}</cbc:LineExtensionAmount>${accCost}
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

  // BT-34 : EndpointID Peppol fournisseur (SIRET prioritaire, puis n° TVA avec scheme EAS du pays)
  const supplierEndpoint = buildEndpointId(data.supplier.siret, data.supplier.taxId);

  const buyerName = data.buyerName ?? 'DEMO INDUSTRIE SAS';

  // BT-49 : EndpointID Peppol acheteur (SIRET prioritaire, puis n° TVA avec scheme EAS du pays)
  const buyerEndpoint = buildEndpointId(data.buyerSiret, data.buyerVatNumber);

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

  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootTag} xmlns="${xmlns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ccts="urn:un:unece:uncefact:documentation:2" xmlns:qdt="urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2" xmlns:udt="urn:oasis:names:specification:ubl:schema:xsd:UnqualifiedDataTypes-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>${cadre.code}</cbc:ProfileID>
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${data.invoiceDate}</cbc:IssueDate>${
    data.dueDate
      ? `
  <cbc:DueDate>${data.dueDate}</cbc:DueDate>`
      : ''
  }
  <${typeCodeTag}>${typeCode}</${typeCodeTag}>
  <cbc:DocumentCurrencyCode>${data.currency}</cbc:DocumentCurrencyCode>${taxCurrencyCodeBlock}
  <cbc:AccountingCost>FRAIS-GESTION-CLASSE6</cbc:AccountingCost>
  <cbc:BuyerReference>${escapeXml(effectiveBuyerReference)}</cbc:BuyerReference>${
    data.note
      ? `
  <cbc:Note>${escapeXml(data.note)}</cbc:Note>`
      : ''
  }${orderReferenceBlock}${billingReferenceBlock}${cisuFrBlocks}

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
${deliveryBlock}${paymentMeans}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${data.currency}">${fmt(totalTax)}</cbc:TaxAmount>${taxSubtotals}
  </cac:TaxTotal>${taxTotalTaxCurrencyBlock}

  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${data.currency}">${fmt(totalExclTax)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${data.currency}">${fmt(totalExclTax)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${data.currency}">${fmt(totalInclTax)}</cbc:TaxInclusiveAmount>
    <cbc:PrepaidAmount currencyID="${data.currency}">${fmt(data.prepaidAmount ?? 0)}</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${data.currency}">${fmt(Math.max(0, totalInclTax - (data.prepaidAmount ?? 0)))}</cbc:PayableAmount>
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
      ["Date d'échéance", data.dueDate ?? '—'],
      ['Devise', data.currency],
      [
        'Type',
        data.direction === 'CREDIT_NOTE'
          ? 'Avoir (381)'
          : data.direction === 'ADVANCE_CREDIT_NOTE'
            ? "Avoir d'acompte (503)"
            : data.direction === 'ADVANCE_INVOICE'
              ? "Facture d'acompte (386)"
              : data.direction === 'CORRECTIVE_INVOICE'
                ? 'Facture rectificative (384)'
                : 'Facture (380)',
      ],
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
    interface PdfTaxGroup {
      cat: string;
      rate: number;
      taxable: number;
      tax: number;
      exemptionCode?: string;
      exemptionReason?: string;
    }
    const pdfTaxGroups = new Map<string, PdfTaxGroup>();
    for (const line of computed.computedLines) {
      const cat = line.taxCategoryCode ?? (line.taxRate === 0 ? 'Z' : 'S');
      const exCode = line.taxExemptionReasonCode ?? '';
      const exReason = line.taxExemptionReason ?? '';
      const key = `${cat}_${line.taxRate}_${exCode}_${exReason}`;
      const g = pdfTaxGroups.get(key) ?? {
        cat,
        rate: line.taxRate,
        taxable: 0,
        tax: 0,
        exemptionCode: line.taxExemptionReasonCode,
        exemptionReason: line.taxExemptionReason,
      };
      pdfTaxGroups.set(key, {
        ...g,
        taxable: round2(g.taxable + line.amountExclTax),
        tax: round2(g.tax + line.taxAmount),
      });
    }

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
    for (const g of pdfTaxGroups.values()) {
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
    doc.text('Total HT', TOT_L, totalY, { width: TOT_W - 70 });
    doc.text(fmt(computed.totalExclTax), TOT_L + TOT_W - 70, totalY, { width: 70, align: 'right' });
    doc.text('TVA totale', TOT_L, totalY + 12, { width: TOT_W - 70 });
    doc.text(fmt(computed.totalTax), TOT_L + TOT_W - 70, totalY + 12, {
      width: 70,
      align: 'right',
    });

    doc.rect(TOT_L - 4, totalY + 26, TOT_W + 8, 18).fill('#1e3a5f');
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text('TOTAL TTC', TOT_L, totalY + 30, { width: TOT_W - 75 });
    doc.text(fmt(computed.totalInclTax), TOT_L + TOT_W - 75, totalY + 30, {
      width: 75,
      align: 'right',
    });
    doc.fillColor('#000000');

    // ── Acompte versé déduit (BT-113) ─────────────────────────────────────────
    if ((data.prepaidAmount ?? 0) > 0) {
      const payable = Math.max(0, computed.totalInclTax - (data.prepaidAmount ?? 0));
      const acompteY = doc.y + 4;
      doc
        .fontSize(8)
        .font('Helvetica')
        .text('Acompte versé :', TOT_L, acompteY, { width: TOT_W - 70 })
        .text(`-${fmt(data.prepaidAmount!)} ${data.currency}`, TOT_L + TOT_W - 70, acompteY, {
          width: 70,
          align: 'right',
        });
      const payableY = doc.y + 2;
      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('Net à payer :', TOT_L, payableY, { width: TOT_W - 75 })
        .text(`${fmt(payable)} ${data.currency}`, TOT_L + TOT_W - 75, payableY, {
          width: 75,
          align: 'right',
        });
    }

    // ── Paiement ──────────────────────────────────────────────────────────────
    const payY = Math.max(tableY + 55, totalY + 60);
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

    if (data.note) {
      pyy += 6;
      doc
        .font('Helvetica')
        .fillColor('#555555')
        .text(`Note : ${data.note}`, LEFT, pyy, { width: PAGE_W });
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
  const computed = computeAmounts(data.lines);
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
      totalExclTax: computed.totalExclTax,
      totalTax: computed.totalTax,
      totalInclTax: computed.totalInclTax,
      prepaidAmount: round2(data.prepaidAmount ?? 0),
      payableAmount: round2(Math.max(0, computed.totalInclTax - (data.prepaidAmount ?? 0))),
      currency: data.currency,
      lineCount: data.lines.length,
      cadreCode: cadre.code,
      cadreLabel: cadre.label,
      cadreWarning: cadreDivergenceWarning(cadre),
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
