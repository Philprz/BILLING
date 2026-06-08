/**
 * Crée l'UDF U_NOVA_Doublon sur la table OCRD (BusinessPartners) de SAP B1 via
 * Service Layer. Marque une fiche fournisseur comme doublon signalé (Y = signalé).
 *
 * Prérequis au rattachement des doublons (le flag SAP est posé en best-effort lors
 * d'un /merge et retiré lors d'un détachement). Doit être exécuté une seule fois sur
 * chaque base SAP B1 (démo ou production). Miroir de create-udf-pa-routage.ts.
 *
 * Script idempotent : si l'UDF existe déjà, ne fait rien.
 *
 * Credentials lus depuis .env (jamais demandés en TTY).
 *
 * Usage : npx tsx scripts/create-udf-nova-doublon.ts
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_CLIENT = process.env.SAP_CLIENT ?? 'SBODemoFR';
const SAP_USER = process.env.SAP_USER ?? 'manager';
const SAP_PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';

const UDF_TABLE = 'OCRD';
const UDF_NAME = 'NOVA_Doublon';
const UDF_DESCRIPTION = 'Marquage NOVA : fournisseur signalé en doublon (Y = signalé)';
const UDF_TYPE = 'db_Alpha';
const UDF_SIZE = 1;

// ─── SAP Service Layer — session ─────────────────────────────────────────────

function extractSapCookieHeader(response: Response): string | null {
  const cookieMap = new Map<string, string>();
  const rawSetCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

  for (const header of rawSetCookies) {
    if (!header) continue;
    for (const name of ['B1SESSION', 'ROUTEID', 'HASH_B1SESSION']) {
      const match = header.match(new RegExp(`${name}=([^;,\\s]+)`));
      if (match?.[1]) cookieMap.set(name, match[1]);
    }
  }
  if (!cookieMap.has('B1SESSION')) return null;
  return [...cookieMap.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

async function sapLogin(): Promise<string> {
  const res = await fetch(`${SAP_BASE_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      CompanyDB: SAP_CLIENT,
      UserName: SAP_USER,
      Password: SAP_PASSWORD,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Login SAP échoué (${res.status}) : ${body.slice(0, 300)}`);
  }
  const cookie = extractSapCookieHeader(res);
  if (!cookie) throw new Error('B1SESSION absent du Set-Cookie');
  return cookie;
}

async function sapLogout(cookie: string): Promise<void> {
  await fetch(`${SAP_BASE_URL}/Logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  }).catch(() => {
    /* best-effort */
  });
}

// ─── Vérification & création de l'UDF ────────────────────────────────────────

interface UserFieldMD {
  TableName?: string;
  Name?: string;
  Description?: string;
  Type?: string;
  Size?: number;
}

async function udfExists(cookie: string): Promise<boolean> {
  // Clé composite SAP B1 : ('OCRD','NOVA_Doublon')
  const url = `${SAP_BASE_URL}/UserFieldsMD?$filter=TableName eq '${UDF_TABLE}' and Name eq '${UDF_NAME}'&$select=TableName,Name`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Cookie: cookie },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET UserFieldsMD (${res.status}) : ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { value?: UserFieldMD[] };
  return (json.value ?? []).length > 0;
}

interface CreateError {
  error?: {
    code?: number | string;
    message?: { value?: string } | string;
  };
}

async function createUdf(cookie: string): Promise<void> {
  const payload = {
    TableName: UDF_TABLE,
    Name: UDF_NAME,
    Description: UDF_DESCRIPTION,
    Type: UDF_TYPE,
    Size: UDF_SIZE,
  };
  const res = await fetch(`${SAP_BASE_URL}/UserFieldsMD`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
  if (res.status === 201 || res.ok) {
    console.log(`[UDF] U_${UDF_NAME} créé avec succès sur ${UDF_TABLE}`);
    return;
  }
  const body = await res.text().catch(() => '');
  // Codes SAP B1 -2028 / -2035 : champ déjà existant (filet de sécurité au cas où le
  // GET de vérification serait insuffisant — ex. concurrence ou cache).
  let parsed: CreateError | null = null;
  try {
    parsed = JSON.parse(body) as CreateError;
  } catch {
    /* ignore */
  }
  const code = parsed?.error?.code;
  if (code === -2028 || code === -2035 || String(code) === '-2028' || String(code) === '-2035') {
    console.log(
      `[UDF] U_${UDF_NAME} existe déjà sur ${UDF_TABLE} (code SAP ${code}) — rien à faire`,
    );
    return;
  }
  console.error(`[UDF] Échec création (HTTP ${res.status}) — corps SAP B1 :`);
  console.error(body);
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non défini dans .env');
  if (!SAP_PASSWORD) {
    throw new Error(
      'SAP_CLIENT_PASSWORD non défini dans .env — décommentez la ligne SAP_CLIENT_PASSWORD avant de relancer.',
    );
  }

  console.log('=== Création UDF U_NOVA_Doublon sur OCRD ===');
  console.log(`SL URL    : ${SAP_BASE_URL}`);
  console.log(`CompanyDB : ${SAP_CLIENT}`);
  console.log(`User      : ${SAP_USER}`);
  console.log('');

  console.log('[1/3] Authentification SAP B1…');
  const cookie = await sapLogin();
  console.log('      OK');

  try {
    console.log("[2/3] Vérification de l'existence de l'UDF…");
    const exists = await udfExists(cookie);
    if (exists) {
      console.log(`[UDF] U_${UDF_NAME} existe déjà sur ${UDF_TABLE} — rien à faire`);
      return;
    }
    console.log('      UDF absent — création requise.');

    console.log("[3/3] Création de l'UDF…");
    await createUdf(cookie);
  } finally {
    console.log('Logout SAP…');
    await sapLogout(cookie);
    console.log('OK');
  }
}

main().catch((err: unknown) => {
  console.error('\nERREUR :', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
