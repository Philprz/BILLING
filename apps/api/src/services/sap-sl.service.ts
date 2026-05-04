/**
 * Client SAP B1 Service Layer — opérations métier (hors auth).
 *
 * Toutes les fonctions reçoivent le b1Session issu du store serveur.
 * Aucun cookie n'est jamais exposé au navigateur.
 */

import fs from 'fs';
import path from 'path';
import { normalizeSapCookieHeader } from './sap-auth.service';
import { findClosestAccounts } from './chart-of-accounts-cache.service';

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');

// ─── Erreur SAP ───────────────────────────────────────────────────────────────

export class SapSlError extends Error {
  readonly sapCode: number;
  readonly sapDetail: string;
  readonly httpStatus: number;

  constructor(sapDetail: string, sapCode = 0, httpStatus = 502) {
    super(sapDetail);
    this.name = 'SapSlError';
    this.sapCode = sapCode;
    this.sapDetail = sapDetail;
    this.httpStatus = httpStatus;
  }
}

/** Extrait le message d'erreur SAP B1 SL depuis le body de la réponse */
function parseSapError(body: unknown): { code: number; message: string } {
  const b = body as Record<string, unknown>;
  const err = b?.error as Record<string, unknown> | undefined;
  const code = typeof err?.code === 'number' ? err.code : 0;
  const msgObj = err?.message as Record<string, unknown> | undefined;
  const raw =
    typeof msgObj?.value === 'string'
      ? msgObj.value
      : typeof err?.message === 'string'
        ? err.message
        : 'Erreur SAP B1 inconnue';
  return { code, message: decodeSapErrorMessage(raw) };
}

/**
 * Traduit les messages d'erreur SAP B1 cryptiques en messages actionnables.
 * Format SAP typique : "[TABLE.FIELD] , 'Message texte'"
 */
/** Extrait tous les AccountCode du payload (DocumentLines ou JournalEntryLines). */
function extractAccountCodesFromPayload(payload: unknown): string[] {
  try {
    const p = payload as {
      DocumentLines?: { AccountCode?: string }[];
      JournalEntryLines?: { AccountCode?: string }[];
    };
    const lines = p?.DocumentLines ?? p?.JournalEntryLines ?? [];
    return lines.map((l) => l.AccountCode).filter((c): c is string => Boolean(c));
  } catch {
    return [];
  }
}

async function enrichAccountCodeError(message: string, payload: unknown): Promise<string> {
  const lower = message.toLowerCase();
  const isAccountCodeError =
    lower.includes('invalid account code') ||
    lower.includes('documentlines.accountcode') ||
    lower.includes('[accountcode]');
  const isNotFound =
    lower.includes('invalid account code') ||
    lower.includes('no matching records') ||
    lower.includes('odbc -2028');

  if (!isAccountCodeError || !isNotFound) return message;

  const allCodes = extractAccountCodesFromPayload(payload);
  if (allCodes.length === 0) return message;

  // SAP B1 utilise des indices 1-based dans ses messages d'erreur
  const lineMatch = message.match(/\[line:\s*(\d+)\]/i);
  let targetCode: string | undefined;
  if (lineMatch) {
    const sapLineNo = parseInt(lineMatch[1], 10);
    targetCode = allCodes[sapLineNo - 1] ?? allCodes[sapLineNo];
  }

  const codesToSuggest = targetCode ? [targetCode] : allCodes;

  const suggestions: string[] = [];
  for (const code of codesToSuggest) {
    try {
      const closest = await findClosestAccounts(code, 3);
      if (closest.length > 0) {
        const prefix = codesToSuggest.length > 1 ? `${code} → ` : '';
        suggestions.push(prefix + closest.map((a) => `${a.acctCode} — ${a.acctName}`).join(' | '));
      }
    } catch {
      // cache inaccessible → on ignore la suggestion
    }
  }

  if (suggestions.length === 0) return message;

  const label = suggestions.length === 1 ? '→ Compte le plus proche' : '→ Comptes les plus proches';
  return message + '\n' + label + ' : ' + suggestions.join(' ; ');
}

function decodeSapErrorMessage(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes('federal tax id') || lower.includes('federaltaxid')) {
    return (
      `${raw}\n\n` +
      `→ SAP B1 exige un numéro de TVA intracommunautaire (FederalTaxID) sur la fiche fournisseur. ` +
      `Ouvrez la fiche Business Partner dans SAP B1 et renseignez le champ "TVA intracommunautaire" ` +
      `(ex : FR12345678901). Distinct du SIRET/SIREN (champ "N° identification entreprise").`
    );
  }

  if (lower.includes('[opch.docrate]') || lower.includes('docrate')) {
    return (
      `${raw}\n\n` +
      `→ Le taux de change (DocRate) est invalide. Vérifiez que la devise de la facture correspond à la devise de base de votre société SAP B1.`
    );
  }

  if (
    lower.includes('duplicate') ||
    lower.includes('already exists') ||
    lower.includes('numatcard')
  ) {
    return (
      `${raw}\n\n` +
      `→ Une facture avec ce numéro de référence (NumAtCard) existe déjà dans SAP B1. Vérifiez si la facture n'a pas déjà été intégrée.`
    );
  }

  if (lower.includes('invalid account code')) {
    return (
      `${raw}\n\n` +
      `→ Un compte comptable de l'écriture n'existe pas dans le plan comptable SAP B1. ` +
      `Ouvrez la facture dans BILLING et modifiez le compte comptable (champ "Compte") sur la ligne concernée ` +
      `pour utiliser un compte valide et actif dans votre plan comptable SAP B1.`
    );
  }

  if (
    (lower.includes('documentlines.accountcode') || lower.includes('[accountcode]')) &&
    (lower.includes('no matching records') || lower.includes('odbc -2028'))
  ) {
    const lineMatch = raw.match(/\[line:\s*(\d+)\]/i);
    const lineHint = lineMatch ? ` sur la ligne n°${lineMatch[1]}` : '';
    return (
      `${raw}\n\n` +
      `→ Le compte comptable${lineHint} n'existe pas dans le plan comptable SAP B1. ` +
      `Ouvrez la facture dans BILLING, identifiez la ligne concernée et modifiez le compte comptable (champ "Compte") ` +
      `pour utiliser un compte valide et actif dans votre plan comptable SAP B1.`
    );
  }

  return raw;
}

/** Headers communs à tous les appels SL */
function sapHeaders(
  sapSessionCookie: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: normalizeSapCookieHeader(sapSessionCookie),
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  };
}

// ─── Upload Attachments2 (multipart) ─────────────────────────────────────────

/**
 * Upload un fichier vers SAP B1 Attachments2 via multipart/form-data.
 * Retourne l'AbsoluteEntry de l'attachement créé.
 * Lance SapSlError si SAP refuse ou si le fichier est introuvable.
 */
export async function uploadAttachment(
  sapSessionCookie: string,
  filePath: string, // chemin absolu sur disque
): Promise<number> {
  // AbsoluteEntry

  if (!fs.existsSync(filePath)) {
    throw new SapSlError(`Fichier introuvable : ${filePath}`, 0, 400);
  }

  const fileContent = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'pdf' ? 'application/pdf' : 'application/xml';

  // Blob + FormData (Node.js 18+ natif)
  const blob = new Blob([fileContent], { type: mimeType });
  const formData = new FormData();
  formData.append('files', blob, filename);

  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/Attachments2`, {
      method: 'POST',
      headers: { Cookie: normalizeSapCookieHeader(sapSessionCookie) }, // pas de Content-Type : laissé à fetch pour boundary
      body: formData,
    });
  } catch (err) {
    throw new SapSlError(`Upload impossible : ${String(err)}`, 0, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    throw new SapSlError(`Échec upload pièce jointe : ${message}`, code, response.status);
  }

  const absoluteEntry = (body as Record<string, unknown>)?.AbsoluteEntry;
  if (typeof absoluteEntry !== 'number') {
    throw new SapSlError('Réponse SAP invalide : AbsoluteEntry absent après upload', 0, 502);
  }

  return absoluteEntry;
}

// ─── Création de documents ────────────────────────────────────────────────────

export interface SapDocResult {
  docEntry: number;
  docNum: number;
}

/**
 * Crée une Purchase Invoice ou Purchase Credit Note dans SAP B1.
 * docType : 'PurchaseInvoices' | 'PurchaseCreditNotes'
 */
export async function createPurchaseDoc(
  sapSessionCookie: string,
  docType: 'PurchaseInvoices' | 'PurchaseCreditNotes',
  payload: unknown,
): Promise<SapDocResult> {
  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/${docType}`, {
      method: 'POST',
      headers: sapHeaders(sapSessionCookie),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors de la création ${docType} : ${String(err)}`, 0, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    // Enrichir l'erreur AccountCode avec le code compte réel et une suggestion
    const enriched = await enrichAccountCodeError(message, payload);
    throw new SapSlError(
      `Erreur SAP ${docType} : ${enriched}`,
      code,
      response.status >= 400 ? 422 : 502,
    );
  }

  const b = body as Record<string, unknown>;
  return {
    docEntry: b.DocEntry as number,
    docNum: b.DocNum as number,
  };
}

// ─── Mise à jour des identifiants fiscaux d'un BusinessPartner ───────────────

export interface SapBpFiscalPatch {
  federalTaxId?: string | null;
}

/**
 * PATCH un fournisseur SAP B1 pour mettre à jour le numéro de TVA intracommunautaire.
 * FederalTaxID = TVA intracommunautaire (FR...)
 * Note: TaxId0 ("N° identification entreprise" / SIRET) n'est pas exposé en écriture
 * dans cette instance SAP B1 — à saisir manuellement dans la fiche fournisseur.
 */
export async function patchBusinessPartnerFiscal(
  sapSessionCookie: string,
  cardCode: string,
  fields: SapBpFiscalPatch,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (fields.federalTaxId !== undefined) body.FederalTaxID = fields.federalTaxId ?? '';

  if (Object.keys(body).length === 0) return;

  const encodedCardCode = encodeURIComponent(`'${cardCode.replace(/'/g, "''")}'`);
  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/BusinessPartners(${encodedCardCode})`, {
      method: 'PATCH',
      headers: sapHeaders(sapSessionCookie),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SapSlError(
      `SAP injoignable lors de la mise à jour fiscale du BP ${cardCode} : ${String(err)}`,
      0,
      502,
    );
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const { code, message } = parseSapError(data);
    throw new SapSlError(
      `Erreur SAP PATCH BusinessPartner ${cardCode} : ${message}`,
      code,
      response.status >= 400 ? 422 : 502,
    );
  }
}

// ─── Création BusinessPartner (fournisseur) ───────────────────────────────────

export interface SapBpCreatePayload {
  cardCode: string;
  cardName: string;
  federalTaxId?: string;
  vatRegNum?: string;
  street?: string;
  street2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  phone?: string;
}

function sapVatRegistrationNumber(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^\d{3}-\d{2}-\d{5}$/.test(trimmed) ? trimmed : undefined;
}

export function buildBusinessPartnerPayload(bp: SapBpCreatePayload): Record<string, unknown> {
  const vatRegistrationNumber = sapVatRegistrationNumber(bp.vatRegNum);

  return {
    CardCode: bp.cardCode,
    CardName: bp.cardName,
    CardType: 'cSupplier',
    ...(bp.federalTaxId ? { FederalTaxID: bp.federalTaxId } : {}),
    ...(vatRegistrationNumber ? { VATRegistrationNumber: vatRegistrationNumber } : {}),
    ...(bp.email ? { EmailAddress: bp.email } : {}),
    ...(bp.phone ? { Phone1: bp.phone } : {}),
    ...(bp.street || bp.street2 || bp.city || bp.postalCode || bp.country
      ? {
          BPAddresses: [
            {
              AddressName: 'Facturation',
              AddressType: 'bo_BillTo',
              Street: bp.street ?? '',
              Block: bp.street2 ?? '',
              ZipCode: bp.postalCode ?? '',
              City: bp.city ?? '',
              Country: bp.country ?? '',
            },
          ],
        }
      : {}),
  };
}

/**
 * Crée un fournisseur (CardType=cSupplier) dans SAP B1.
 * Retourne le CardCode tel que confirmé par SAP.
 */
export async function createBusinessPartner(
  sapSessionCookie: string,
  bp: SapBpCreatePayload,
): Promise<{ cardCode: string }> {
  const body = buildBusinessPartnerPayload(bp);

  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/BusinessPartners`, {
      method: 'POST',
      headers: sapHeaders(sapSessionCookie),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SapSlError(
      `SAP injoignable lors de la création BusinessPartner : ${String(err)}`,
      0,
      502,
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(data);
    throw new SapSlError(
      `Erreur SAP BusinessPartner : ${message}`,
      code,
      response.status >= 400 ? 422 : 502,
    );
  }

  const cardCode = (data as Record<string, unknown>).CardCode as string;
  return { cardCode: cardCode ?? bp.cardCode };
}

/**
 * Crée une Journal Entry dans SAP B1.
 */
export async function createJournalEntry(
  sapSessionCookie: string,
  payload: unknown,
): Promise<SapDocResult> {
  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/JournalEntries`, {
      method: 'POST',
      headers: sapHeaders(sapSessionCookie),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new SapSlError(
      `SAP injoignable lors de la création JournalEntry : ${String(err)}`,
      0,
      502,
    );
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    const enriched = await enrichAccountCodeError(message, payload);
    throw new SapSlError(
      `Erreur SAP JournalEntry : ${enriched}`,
      code,
      response.status >= 400 ? 422 : 502,
    );
  }

  const b = body as Record<string, unknown>;
  return {
    docEntry: b.JdtNum as number, // Journal entries utilisent JdtNum comme clé
    docNum: b.JdtNum as number,
  };
}

// ─── Voie B : recherche facture SAP par NumAtCard ────────────────────────────

export interface SapPurchaseInvoiceRef {
  docEntry: number;
  docNum: number;
  cardCode: string;
  cardName: string;
  numAtCard: string;
  docDate: string;
  docTotal: number;
  attachmentEntry: number | null;
}

export type FindByNumAtCardResult =
  | { found: 'none' }
  | { found: 'one'; invoice: SapPurchaseInvoiceRef }
  | { found: 'many'; invoices: SapPurchaseInvoiceRef[] };

/** Échappe les apostrophes dans un littéral OData ($filter string). */
function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Recherche une PurchaseInvoice SAP B1 par NumAtCard (= numéro de référence vendeur).
 * Si cardCode est fourni, la recherche est restreinte à ce fournisseur.
 *
 * Retourne :
 *   { found: 'none' }                          — aucun document trouvé
 *   { found: 'one',  invoice }                 — exactement un document
 *   { found: 'many', invoices }                — plusieurs candidats (pas de choix automatique)
 */
export async function findPurchaseInvoiceByNumAtCard(
  sapSessionCookie: string,
  numAtCard: string,
  cardCode?: string,
): Promise<FindByNumAtCardResult> {
  const escaped = odataEscape(numAtCard);
  let filter = `NumAtCard eq '${escaped}'`;
  if (cardCode) {
    filter += ` and CardCode eq '${odataEscape(cardCode)}'`;
  }
  const select = 'DocEntry,DocNum,CardCode,CardName,NumAtCard,DocDate,DocTotal,AttachmentEntry';
  const url = `${SAP_BASE_URL}/PurchaseInvoices?$select=${select}&$filter=${encodeURIComponent(filter)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Cookie: normalizeSapCookieHeader(sapSessionCookie) },
    });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors de la recherche NumAtCard : ${String(err)}`, 0, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    throw new SapSlError(
      `Erreur SAP recherche NumAtCard : ${message}`,
      code,
      response.status >= 400 ? 422 : 502,
    );
  }

  const items = ((body as Record<string, unknown>).value ?? []) as Record<string, unknown>[];
  const mapped: SapPurchaseInvoiceRef[] = items.map((item) => ({
    docEntry: item.DocEntry as number,
    docNum: item.DocNum as number,
    cardCode: item.CardCode as string,
    cardName: item.CardName as string,
    numAtCard: item.NumAtCard as string,
    docDate: item.DocDate as string,
    docTotal: item.DocTotal as number,
    attachmentEntry:
      typeof item.AttachmentEntry === 'number' && item.AttachmentEntry > 0
        ? (item.AttachmentEntry as number)
        : null,
  }));

  if (mapped.length === 0) return { found: 'none' };
  if (mapped.length === 1) return { found: 'one', invoice: mapped[0] };
  return { found: 'many', invoices: mapped };
}

// ─── Voie B : pièce jointe sur facture SAP existante ─────────────────────────

/**
 * Upload un fichier en pièce jointe d'une PurchaseInvoice SAP déjà existante.
 *
 * Étapes :
 *   1. Vérifie que la facture SAP n'a pas déjà une pièce jointe (limite technique :
 *      l'ajout de lignes à un Attachments2 existant n'est pas supporté via multipart).
 *   2. Upload le fichier via POST /Attachments2 → récupère AbsoluteEntry.
 *   3. PATCH PurchaseInvoices(docEntry) avec AttachmentEntry = AbsoluteEntry.
 *
 * Retourne AbsoluteEntry créé.
 * Lance SapSlError si :
 *   - la facture SAP a déjà une pièce jointe (existingAttachmentEntry != null)
 *   - l'upload échoue
 *   - le PATCH échoue
 */
export async function attachFileToExistingPurchaseInvoice(
  sapSessionCookie: string,
  docEntry: number,
  filePath: string,
  existingAttachmentEntry: number | null,
): Promise<number> {
  // Limite technique : on ne fusionne pas les Attachments2 via multipart.
  if (existingAttachmentEntry !== null) {
    throw new SapSlError(
      `La facture SAP DocEntry=${docEntry} a déjà une pièce jointe (AbsoluteEntry=${existingAttachmentEntry}). ` +
        `La fusion d'Attachments2 via multipart n'est pas supportée — veuillez rattacher manuellement dans SAP B1.`,
      0,
      409,
    );
  }

  // Upload du fichier
  const absoluteEntry = await uploadAttachment(sapSessionCookie, filePath);

  // PATCH PurchaseInvoices(docEntry) pour pointer sur la pièce jointe
  let patchResponse: Response;
  try {
    patchResponse = await fetch(`${SAP_BASE_URL}/PurchaseInvoices(${docEntry})`, {
      method: 'PATCH',
      headers: sapHeaders(sapSessionCookie),
      body: JSON.stringify({ AttachmentEntry: absoluteEntry }),
    });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors du PATCH AttachmentEntry : ${String(err)}`, 0, 502);
  }

  if (!patchResponse.ok) {
    const patchBody = await patchResponse.json().catch(() => ({}));
    const { code, message } = parseSapError(patchBody);
    throw new SapSlError(
      `Échec PATCH PurchaseInvoices(${docEntry}) AttachmentEntry : ${message}`,
      code,
      patchResponse.status >= 400 ? 422 : 502,
    );
  }

  return absoluteEntry;
}

// ─── Ping / test connexion ────────────────────────────────────────────────────

export async function pingServiceLayer(
  sapSessionCookie: string,
): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SAP_BASE_URL}/CompanyService_GetAdminInfo`, {
      method: 'POST',
      headers: { ...sapHeaders(sapSessionCookie), 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { ok: res.ok || res.status === 405, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

// ─── Plan comptable (ChartOfAccounts) ────────────────────────────────────────

export interface AccountEntry {
  acctCode: string;
  acctName: string;
  activeAccount: boolean;
  postable: boolean;
  accountLevel: number | null;
  groupMask: number | null;
}

function sapBool(value: unknown): boolean {
  return value === true || value === 'tYES' || value === 'Y' || value === 'YES' || value === '1';
}

type ChartRow = {
  Code: string;
  FormatCode?: string | null;
  Name: string;
  ActiveAccount?: unknown;
  Postable?: unknown;
  AccountLevel?: number | null;
  GroupMask?: number | null;
};

function mapChartRow(r: ChartRow): AccountEntry {
  return {
    acctCode: r.Code || r.FormatCode || '',
    acctName: r.Name,
    activeAccount: sapBool(r.ActiveAccount),
    postable: r.Postable !== undefined ? sapBool(r.Postable) : true,
    accountLevel: r.AccountLevel ?? null,
    groupMask: r.GroupMask ?? null,
  };
}

async function fetchChartOfAccountsClass(
  cookie: string,
  classPrefix: string,
): Promise<AccountEntry[]> {
  const filter = encodeURIComponent(
    `startswith(Code,'${classPrefix}') or startswith(FormatCode,'${classPrefix}')`,
  );
  const PAGE = 100;
  const BASE = `${SAP_BASE_URL}/ChartOfAccounts?$select=Code,FormatCode,Name,ActiveAccount&$filter=${filter}&$orderby=Code asc&$top=${PAGE}`;

  const all: AccountEntry[] = [];
  let nextUrl: string | null = BASE;
  let page = 0;

  while (nextUrl && page < 100) {
    page++;
    let res: Response;
    try {
      res = await fetch(nextUrl, { headers: { Cookie: cookie } });
    } catch {
      break;
    }
    if (!res.ok) break;

    const body = (await res.json()) as {
      value: ChartRow[];
      'odata.nextLink'?: string;
      '@odata.nextLink'?: string;
    };
    const rows = (body.value ?? []).map(mapChartRow).filter((r) => r.acctCode.length > 0);
    all.push(...rows);

    const rawNext = body['odata.nextLink'] ?? body['@odata.nextLink'];
    if (rawNext) {
      nextUrl = rawNext.startsWith('http')
        ? rawNext
        : `${SAP_BASE_URL.replace(/\/ChartOfAccounts.*/, '')}/${rawNext.replace(/^\//, '')}`;
    } else if (rows.length === PAGE) {
      nextUrl = `${BASE}&$skip=${all.length}`;
    } else {
      nextUrl = null;
    }
  }
  return all;
}

export async function fetchChartOfAccounts(sapSessionCookie: string): Promise<AccountEntry[]> {
  const cookie = normalizeSapCookieHeader(sapSessionCookie);
  // SAP B1 peut limiter la pagination sans filtre → on interroge classe par classe (1-9).
  const classes = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const results = await Promise.allSettled(
    classes.map((c) => fetchChartOfAccountsClass(cookie, c)),
  );

  const all: AccountEntry[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const entry of r.value) {
        if (!seen.has(entry.acctCode)) {
          seen.add(entry.acctCode);
          all.push(entry);
        }
      }
    }
  }
  all.sort((a, b) => a.acctCode.localeCompare(b.acctCode));
  console.log(`[fetchChartOfAccounts] ${all.length} compte(s) récupéré(s) (classes 1-9)`);
  return all;
}

// ─── Groupes TVA (VatGroups) ──────────────────────────────────────────────────

export interface VatGroupEntry {
  code: string;
  name: string;
  rate: number;
  active: boolean;
  raw: Record<string, unknown>;
}

/**
 * Récupère les groupes TVA depuis SAP B1 Service Layer.
 * Essaie VatGroups (SAP B1 standard), puis SalesTaxCodes si non dispo.
 * Retourne [] si SAP ne supporte ni l'un ni l'autre (ne lance pas d'erreur).
 */
export async function fetchVatGroups(sapSessionCookie: string): Promise<VatGroupEntry[]> {
  const cookie = normalizeSapCookieHeader(sapSessionCookie);

  async function tryResource(resource: string): Promise<VatGroupEntry[] | null> {
    const url = `${SAP_BASE_URL}/${resource}?$top=100`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Cookie: cookie } });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    const body = (await res.json().catch(() => ({ value: [] }))) as {
      value: Record<string, unknown>[];
    };
    if (!Array.isArray(body.value) || body.value.length === 0) return null;

    const first = body.value[0];
    console.log('[fetchVatGroups] Premier enregistrement brut:', JSON.stringify(first));

    return body.value
      .map((r) => {
        const code = String(r['Code'] ?? r['VatCode'] ?? r['TaxCode'] ?? '').trim();
        const name = String(r['Name'] ?? r['VatName'] ?? r['TaxName'] ?? code).trim();
        const rateRaw = r['Rate'] ?? r['VatRate'] ?? r['TaxRate'] ?? r['Percent'] ?? 0;
        const rate = typeof rateRaw === 'number' ? rateRaw : parseFloat(String(rateRaw)) || 0;
        const activeRaw = r['Inactive'] ?? r['Active'];
        let active: boolean;
        if (typeof activeRaw === 'boolean') {
          active = r['Inactive'] !== undefined ? !activeRaw : activeRaw;
        } else if (activeRaw === 'tNO' || activeRaw === 'N' || activeRaw === 'NO') {
          active = r['Inactive'] !== undefined ? false : true;
        } else {
          active = true;
        }
        return { code, name, rate, active, raw: r };
      })
      .filter((e) => e.code.length > 0);
  }

  const fromVatGroups = await tryResource('VatGroups');
  if (fromVatGroups && fromVatGroups.length > 0) return fromVatGroups;

  const fromSalesTax = await tryResource('SalesTaxCodes');
  if (fromSalesTax && fromSalesTax.length > 0) return fromSalesTax;

  return [];
}

export async function searchChartOfAccounts(
  sapSessionCookie: string,
  query: string,
): Promise<AccountEntry[]> {
  const cookie = normalizeSapCookieHeader(sapSessionCookie);
  const q = query.replace(/'/g, "''");
  // Requête numérique (ex: "6", "60") → startswith sur le code pour matcher la classe comptable.
  // Requête texte → contains sur code + nom.
  const isCodePrefix = /^\d+$/.test(q);
  const filter = isCodePrefix
    ? `ActiveAccount eq 'tYES' and (startswith(Code,'${q}') or startswith(FormatCode,'${q}'))`
    : `ActiveAccount eq 'tYES' and (contains(Code,'${q}') or contains(FormatCode,'${q}') or contains(Name,'${q}'))`;
  const url = `${SAP_BASE_URL}/ChartOfAccounts?$select=Code,FormatCode,Name,ActiveAccount&$filter=${encodeURIComponent(filter)}&$top=40`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Cookie: cookie } });
  } catch (err) {
    throw new SapSlError(
      `SAP injoignable lors de la recherche de comptes : ${String(err)}`,
      0,
      502,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new SapSlError(`SAP ChartOfAccounts search (${res.status}): ${text}`, 0, 502);
  }

  const body = (await res.json()) as {
    value: {
      Code: string;
      FormatCode?: string | null;
      Name: string;
      ActiveAccount?: unknown;
      Postable?: unknown;
      AccountLevel?: number | null;
      GroupMask?: number | null;
    }[];
  };
  return (body.value ?? [])
    .map((r) => ({
      acctCode: r.Code || r.FormatCode || '',
      acctName: r.Name,
      activeAccount: sapBool(r.ActiveAccount),
      postable: r.Postable !== undefined ? sapBool(r.Postable) : true,
      accountLevel: r.AccountLevel ?? null,
      groupMask: r.GroupMask ?? null,
    }))
    .filter((r) => r.acctCode.length > 0);
}

// ─── Création UDF U_PA_REF sur OPCH ──────────────────────────────────────────

export interface UdfCreateResult {
  alreadyExists: boolean;
  fieldName: string;
}

/**
 * Crée le champ utilisateur U_PA_REF sur la table OPCH (factures fournisseur SAP B1).
 * Idempotent : retourne alreadyExists=true si le champ existe déjà (code SAP -2035).
 */
export async function createSapUdfPaRef(sapSessionCookie: string): Promise<UdfCreateResult> {
  const response = await fetch(`${SAP_BASE_URL}/UserFieldsMD`, {
    method: 'POST',
    headers: sapHeaders(sapSessionCookie),
    body: JSON.stringify({
      TableName: 'OPCH',
      Name: 'PA_REF',
      Description: 'Référence passerelle PA (paMessageId)',
      Type: 'db_Alpha',
      Size: 100,
    }),
  });

  if (response.status === 201 || response.ok) {
    return { alreadyExists: false, fieldName: 'U_PA_REF' };
  }

  const body = await response.json().catch(() => ({}));
  const sapCode = (body as { error?: { code?: number } })?.error?.code;
  // SAP B1 retourne -2035 quand le champ existe déjà
  if (sapCode === -2035 || response.status === 409) {
    return { alreadyExists: true, fieldName: 'U_PA_REF' };
  }

  const { message } = parseSapError(body);
  throw new SapSlError(message, sapCode ?? 0, response.status);
}
