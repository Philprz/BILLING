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
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const errObj = body?.error as Record<string, unknown> | undefined;
    const msgObj = errObj?.message as Record<string, unknown> | undefined;
    const detail =
      typeof msgObj?.value === 'string'
        ? msgObj.value
        : 'Identifiants incorrects ou accès refusé';
    const code = response.status === 401 || response.status === 403 ? 401 : 400;
    throw new SapAuthError(detail, code);
  }

  // Extraction du B1SESSION depuis l'en-tête Set-Cookie
  const setCookieHeader = response.headers.get('set-cookie') ?? '';
  const b1Session = extractB1Session(setCookieHeader);
  if (!b1Session) {
    throw new SapAuthError('Réponse SAP invalide : B1SESSION absent', 502);
  }

  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const sessionTimeout = typeof body.SessionTimeout === 'number' ? body.SessionTimeout : 30;

  return { b1Session, sessionTimeoutMinutes: sessionTimeout };
}

/**
 * Appelle POST /b1s/v1/Logout.
 * Best-effort : si SAP est injoignable, la session expirera naturellement.
 */
export async function sapLogout(b1Session: string): Promise<void> {
  await fetch(`${SAP_BASE_URL}/Logout`, {
    method: 'POST',
    headers: { Cookie: `B1SESSION=${b1Session}` },
  }).catch(() => {
    // SAP injoignable : pas bloquant, la session expirera côté SAP
  });
}

/**
 * Ping léger pour maintenir la session SAP active.
 * À appeler toutes les ~25 minutes si keep-alive est activé.
 */
export async function sapPing(b1Session: string): Promise<boolean> {
  try {
    const response = await fetch(`${SAP_BASE_URL}/CompanyService_GetCompanyInfo`, {
      method: 'POST',
      headers: {
        Cookie: `B1SESSION=${b1Session}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
}

function extractB1Session(setCookieHeader: string): string | null {
  const match = setCookieHeader.match(/B1SESSION=([^;,\s]+)/);
  return match?.[1] ?? null;
}
