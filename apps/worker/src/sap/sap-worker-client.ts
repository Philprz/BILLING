/**
 * Client SAP B1 Service Layer — côté WORKER (compte de service).
 *
 * Le worker n'a pas de session utilisateur : il se connecte avec les identifiants
 * de service (.env, mêmes variables que les scripts d'inspection). Surface MINIMALE
 * et exclusivement au service du suivi « niveau payé » (Partie B) :
 *   - lecture seule de l'état de règlement d'un poste (DocTotal/PaidToDate/DocumentStatus) ;
 *   - garantie d'existence de l'UDF U_NOVA_Statut (idempotent) ;
 *   - réécriture (PATCH) de l'UDF de suivi — JAMAIS un paiement.
 *
 * Sécurité : ce client ne crée AUCUN paiement. Le seul write est le PATCH de l'UDF
 * de suivi, et l'appelant (job) le borne par SAP_POST_POLICY.
 */

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const COMPANY_DB = process.env.SAP_CLIENT ?? '';
const SAP_USER = process.env.SAP_USER ?? '';
const SAP_PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';

// Cert auto-signé du SL : aligné sur le comportement des scripts d'inspection.
if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export class SapWorkerError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus = 502) {
    super(message);
    this.name = 'SapWorkerError';
    this.httpStatus = httpStatus;
  }
}

let cachedCookie: string | null = null;

/** Login compte de service → cookie B1SESSION. Met en cache (réutilisé tant que valide). */
export async function sapServiceLogin(force = false): Promise<string> {
  if (cachedCookie && !force) return cachedCookie;
  if (!SAP_BASE_URL || !COMPANY_DB || !SAP_USER || !SAP_PASSWORD) {
    throw new SapWorkerError(
      'Configuration SAP worker incomplète (SAP_REST_BASE_URL / SAP_CLIENT / SAP_USER / SAP_CLIENT_PASSWORD).',
      500,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${SAP_BASE_URL}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CompanyDB: COMPANY_DB, UserName: SAP_USER, Password: SAP_PASSWORD }),
    });
  } catch (err) {
    throw new SapWorkerError(`SAP injoignable (Login) : ${String(err)}`, 502);
  }
  if (!res.ok) throw new SapWorkerError(`Login SAP échoué : HTTP ${res.status}`, res.status);
  const setCookie =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : (res.headers.get('set-cookie') ?? '');
  const b1 = setCookie.match(/B1SESSION=([^;,\s]+)/)?.[1];
  if (!b1) throw new SapWorkerError('B1SESSION absent dans la réponse Login', 502);
  cachedCookie = `B1SESSION=${b1}`;
  return cachedCookie;
}

/** Exécute un appel SL avec ré-authentification automatique sur 401 (1 retry). */
async function withSession(fn: (cookie: string) => Promise<Response>): Promise<Response> {
  let cookie = await sapServiceLogin();
  let res = await fn(cookie);
  if (res.status === 401) {
    cookie = await sapServiceLogin(true);
    res = await fn(cookie);
  }
  return res;
}

/** État de règlement d'un poste fournisseur (lecture seule). `null` si introuvable. */
export interface WorkerInvoiceSettlement {
  docEntry: number;
  docTotal: number;
  paidToDate: number;
  documentStatus: string | null;
}

export async function fetchInvoiceSettlement(
  docEntry: number,
): Promise<WorkerInvoiceSettlement | null> {
  const url = `${SAP_BASE_URL}/PurchaseInvoices(${docEntry})?$select=DocEntry,DocTotal,PaidToDate,DocumentStatus`;
  const res = await withSession((cookie) => fetch(url, { headers: { Cookie: cookie } }));
  if (res.status === 404) return null;
  if (!res.ok)
    throw new SapWorkerError(`Lecture poste ${docEntry} : HTTP ${res.status}`, res.status);
  const o = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    docEntry: (o.DocEntry as number) ?? docEntry,
    docTotal: typeof o.DocTotal === 'number' ? o.DocTotal : Number(o.DocTotal) || 0,
    paidToDate: typeof o.PaidToDate === 'number' ? o.PaidToDate : Number(o.PaidToDate) || 0,
    documentStatus: typeof o.DocumentStatus === 'string' ? o.DocumentStatus : null,
  };
}

/** Garantit l'existence de l'UDF U_NOVA_Statut sur OPCH (idempotent, code SAP −2035). */
export async function ensureUdfNovaStatut(): Promise<{ alreadyExists: boolean }> {
  const res = await withSession((cookie) =>
    fetch(`${SAP_BASE_URL}/UserFieldsMD`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        TableName: 'OPCH',
        Name: 'NOVA_Statut',
        Description: 'Niveau payé NOVA (NON_PAYE<PROGRAMME<PARTIEL<PAYE<SOLDE)',
        Type: 'db_Alpha',
        Size: 20,
      }),
    }),
  );
  if (res.status === 201 || res.ok) return { alreadyExists: false };
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
  if (body?.error?.code === -2035 || res.status === 409) return { alreadyExists: true };
  throw new SapWorkerError(`Création UDF NOVA_Statut : HTTP ${res.status}`, res.status);
}

/** Réécrit l'UDF U_NOVA_Statut sur une PurchaseInvoices (PATCH de suivi, jamais un paiement). */
export async function patchUdfNovaStatut(docEntry: number, value: string): Promise<void> {
  const res = await withSession((cookie) =>
    fetch(`${SAP_BASE_URL}/PurchaseInvoices(${docEntry})`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ U_NOVA_Statut: value }),
    }),
  );
  if (!res.ok) {
    throw new SapWorkerError(`PATCH U_NOVA_Statut ${docEntry} : HTTP ${res.status}`, res.status);
  }
}
