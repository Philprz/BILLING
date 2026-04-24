// Service d'authentification SAP B1 Service Layer
// Le B1SESSION reçu de SAP est conservé côté serveur uniquement.

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_LANG = process.env.SAP_LANG ?? 'FR';

export class SapAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'SapAuthError';
    this.statusCode = statusCode;
  }
}

export interface SapLoginResult {
  b1Session: string;
  sapCookieHeader: string;
  sessionTimeoutMinutes: number;
}

/**
 * Appelle POST /b1s/v1/Login sur SAP Service Layer.
 * Extrait le cookie B1SESSION de la réponse.
 * Lance SapAuthError si SAP refuse ou est injoignable.
 */
export async function sapLogin(
  companyDb: string,
  userName: string,
  password: string,
): Promise<SapLoginResult> {
  if (!SAP_BASE_URL) {
    throw new SapAuthError('SAP_REST_BASE_URL non configurée', 500);
  }

  let response: Response;
  try {
    // Language est optionnel : SAP B1 SL n'accepte pas tous les formats de code langue.
    // On l'inclut uniquement si SAP_LANG est un entier (code numérique SAP).
    const langCode = Number(SAP_LANG);
    const loginPayload: Record<string, unknown> = {
      CompanyDB: companyDb,
      UserName: userName,
      Password: password,
    };
    if (!Number.isNaN(langCode)) loginPayload.Language = langCode;

    response = await fetch(`${SAP_BASE_URL}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginPayload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SapAuthError(`Impossible de joindre SAP B1 : ${msg}`, 502);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const errObj = body?.error as Record<string, unknown> | undefined;
    const msgObj = errObj?.message as Record<string, unknown> | undefined;
    const detail =
      typeof msgObj?.value === 'string' ? msgObj.value : 'Identifiants incorrects ou accès refusé';
    const code = response.status === 401 || response.status === 403 ? 401 : 400;
    throw new SapAuthError(detail, code);
  }

  // Extraction du B1SESSION depuis l'en-tête Set-Cookie
  const sapCookieHeader = extractSapCookieHeader(response);
  const b1Session = sapCookieHeader ? extractCookieValue(sapCookieHeader, 'B1SESSION') : null;
  if (!sapCookieHeader || !b1Session) {
    throw new SapAuthError('Réponse SAP invalide : B1SESSION absent', 502);
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionTimeout = typeof body.SessionTimeout === 'number' ? body.SessionTimeout : 30;

  return { b1Session, sapCookieHeader, sessionTimeoutMinutes: sessionTimeout };
}

/**
 * Appelle POST /b1s/v1/Logout.
 * Best-effort : si SAP est injoignable, la session expirera naturellement.
 */
export async function sapLogout(sapSessionCookie: string): Promise<void> {
  await fetch(`${SAP_BASE_URL}/Logout`, {
    method: 'POST',
    headers: { Cookie: normalizeSapCookieHeader(sapSessionCookie) },
  }).catch(() => {
    // SAP injoignable : pas bloquant, la session expirera côté SAP
  });
}

/**
 * Ping léger pour maintenir la session SAP active.
 * À appeler toutes les ~25 minutes si keep-alive est activé.
 */
export async function sapPing(sapSessionCookie: string): Promise<boolean> {
  try {
    const response = await fetch(`${SAP_BASE_URL}/CompanyService_GetCompanyInfo`, {
      method: 'POST',
      headers: {
        Cookie: normalizeSapCookieHeader(sapSessionCookie),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function normalizeSapCookieHeader(sapSessionCookie: string): string {
  return sapSessionCookie.includes('=') ? sapSessionCookie : `B1SESSION=${sapSessionCookie}`;
}

function extractSapCookieHeader(response: Response): string | null {
  const cookieMap = new Map<string, string>();
  const rawSetCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

  for (const header of rawSetCookies) {
    if (!header) continue;

    for (const name of ['B1SESSION', 'ROUTEID', 'HASH_B1SESSION']) {
      const value = extractCookieValue(header, name);
      if (value) cookieMap.set(name, value);
    }
  }

  if (!cookieMap.has('B1SESSION')) {
    return null;
  }

  return [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function extractCookieValue(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`${name}=([^;,\\s]+)`));
  return match?.[1] ?? null;
}
