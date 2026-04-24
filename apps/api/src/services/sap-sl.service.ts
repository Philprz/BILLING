/**
 * Client SAP B1 Service Layer — opérations métier (hors auth).
 *
 * Toutes les fonctions reçoivent le b1Session issu du store serveur.
 * Aucun cookie n'est jamais exposé au navigateur.
 */

import fs from 'fs';
import path from 'path';
import { normalizeSapCookieHeader } from './sap-auth.service';

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
  const message =
    typeof msgObj?.value === 'string'
      ? msgObj.value
      : typeof err?.message === 'string'
        ? err.message
        : 'Erreur SAP B1 inconnue';
  return { code, message };
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
    throw new SapSlError(
      `Erreur SAP ${docType} : ${message}`,
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

// ─── Création BusinessPartner (fournisseur) ───────────────────────────────────

export interface SapBpCreatePayload {
  cardCode: string;
  cardName: string;
  federalTaxId?: string;
}

/**
 * Crée un fournisseur (CardType=cSupplier) dans SAP B1.
 * Retourne le CardCode tel que confirmé par SAP.
 */
export async function createBusinessPartner(
  sapSessionCookie: string,
  bp: SapBpCreatePayload,
): Promise<{ cardCode: string }> {
  const body: Record<string, unknown> = {
    CardCode: bp.cardCode,
    CardName: bp.cardName,
    CardType: 'cSupplier',
    ...(bp.federalTaxId ? { FederalTaxID: bp.federalTaxId } : {}),
  };

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
    throw new SapSlError(
      `Erreur SAP JournalEntry : ${message}`,
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
  level: number;
}

export async function fetchChartOfAccounts(sapSessionCookie: string): Promise<AccountEntry[]> {
  const cookie = normalizeSapCookieHeader(sapSessionCookie);
  const url = `${SAP_BASE_URL}/ChartOfAccounts?$select=Code,Name,Level&$filter=ActiveAccount eq 'tYES'&$top=500`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Cookie: cookie } });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors du plan comptable : ${String(err)}`, 0, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new SapSlError(`SAP ChartOfAccounts (${res.status}): ${text}`, 0, 502);
  }

  const body = (await res.json()) as { value: { Code: string; Name: string; Level: number }[] };
  return (body.value ?? []).map((r) => ({ acctCode: r.Code, acctName: r.Name, level: r.Level }));
}
