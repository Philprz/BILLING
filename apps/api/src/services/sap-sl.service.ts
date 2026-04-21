/**
 * Client SAP B1 Service Layer — opérations métier (hors auth).
 *
 * Toutes les fonctions reçoivent le b1Session issu du store serveur.
 * Aucun cookie n'est jamais exposé au navigateur.
 */

import fs from 'fs';
import path from 'path';

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');

// ─── Erreur SAP ───────────────────────────────────────────────────────────────

export class SapSlError extends Error {
  readonly sapCode:   number;
  readonly sapDetail: string;
  readonly httpStatus: number;

  constructor(sapDetail: string, sapCode = 0, httpStatus = 502) {
    super(sapDetail);
    this.name      = 'SapSlError';
    this.sapCode   = sapCode;
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
function sapHeaders(b1Session: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Cookie':        `B1SESSION=${b1Session}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
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
  b1Session: string,
  filePath:  string,   // chemin absolu sur disque
): Promise<number> {   // AbsoluteEntry

  if (!fs.existsSync(filePath)) {
    throw new SapSlError(`Fichier introuvable : ${filePath}`, 0, 400);
  }

  const fileContent = fs.readFileSync(filePath);
  const filename    = path.basename(filePath);
  const ext         = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType    = ext === 'pdf' ? 'application/pdf' : 'application/xml';

  // Blob + FormData (Node.js 18+ natif)
  const blob     = new Blob([fileContent], { type: mimeType });
  const formData = new FormData();
  formData.append('files', blob, filename);

  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/Attachments2`, {
      method:  'POST',
      headers: { Cookie: `B1SESSION=${b1Session}` }, // pas de Content-Type : laissé à fetch pour boundary
      body:    formData,
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
  docNum:   number;
}

/**
 * Crée une Purchase Invoice ou Purchase Credit Note dans SAP B1.
 * docType : 'PurchaseInvoices' | 'PurchaseCreditNotes'
 */
export async function createPurchaseDoc(
  b1Session: string,
  docType:   'PurchaseInvoices' | 'PurchaseCreditNotes',
  payload:   unknown,
): Promise<SapDocResult> {

  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/${docType}`, {
      method:  'POST',
      headers: sapHeaders(b1Session),
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors de la création ${docType} : ${String(err)}`, 0, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    throw new SapSlError(`Erreur SAP ${docType} : ${message}`, code, response.status >= 400 ? 422 : 502);
  }

  const b = body as Record<string, unknown>;
  return {
    docEntry: b.DocEntry as number,
    docNum:   b.DocNum   as number,
  };
}

/**
 * Crée une Journal Entry dans SAP B1.
 */
export async function createJournalEntry(
  b1Session: string,
  payload:   unknown,
): Promise<SapDocResult> {

  let response: Response;
  try {
    response = await fetch(`${SAP_BASE_URL}/JournalEntries`, {
      method:  'POST',
      headers: sapHeaders(b1Session),
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    throw new SapSlError(`SAP injoignable lors de la création JournalEntry : ${String(err)}`, 0, 502);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, message } = parseSapError(body);
    throw new SapSlError(`Erreur SAP JournalEntry : ${message}`, code, response.status >= 400 ? 422 : 502);
  }

  const b = body as Record<string, unknown>;
  return {
    docEntry: b.JdtNum as number,   // Journal entries utilisent JdtNum comme clé
    docNum:   b.JdtNum as number,
  };
}
