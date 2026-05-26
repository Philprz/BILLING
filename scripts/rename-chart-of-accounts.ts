/**
 * Corrige les libellés (champ Name) de 11 comptes créés par
 * scripts/sync-chart-of-accounts.ts dans SAP B1 (SBODemoFR).
 * PATCH ne touche QUE Name — AccountType, FatherAccountKey, ActiveAccount restent intacts.
 *
 * Usage : npx tsx scripts/rename-chart-of-accounts.ts
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

const RENAMES: Array<{ code: string; name: string }> = [
  { code: '606500', name: 'Fournitures médicales' },
  { code: '627000', name: 'Services bancaires et assimilés' },
  { code: '628000', name: 'Divers (frais et charges)' },
  { code: '635000', name: 'Cotisation foncière des entreprises (CFE)' },
  { code: '635100', name: 'Taxe foncière' },
  { code: '645000', name: 'Cotisations URSSAF et organismes sociaux' },
  { code: '647000', name: 'Autres charges sociales' },
  { code: '651000', name: 'Redevances pour concessions, brevets, licences' },
  { code: '661200', name: 'Intérêts des comptes courants et dépôts créditeurs' },
  { code: '671000', name: 'Charges exceptionnelles sur opérations de gestion' },
  { code: '672000', name: 'Charges sur exercices antérieurs' },
];

function extractSapCookieHeader(res: Response): string | null {
  const map = new Map<string, string>();
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const h of raw) {
    if (!h) continue;
    for (const n of ['B1SESSION', 'ROUTEID', 'HASH_B1SESSION']) {
      const m = h.match(new RegExp(`${n}=([^;,\\s]+)`));
      if (m?.[1]) map.set(n, m[1]);
    }
  }
  if (!map.has('B1SESSION')) return null;
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

async function sapLogin(): Promise<string> {
  const res = await fetch(`${SAP_BASE_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_CLIENT, UserName: SAP_USER, Password: SAP_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Login SAP (${res.status}) : ${body.slice(0, 300)}`);
  }
  const cookie = extractSapCookieHeader(res);
  if (!cookie) throw new Error('B1SESSION absent du Set-Cookie');
  return cookie;
}

async function sapLogout(cookie: string): Promise<void> {
  await fetch(`${SAP_BASE_URL}/Logout`, { method: 'POST', headers: { Cookie: cookie } }).catch(
    () => {
      /* best-effort */
    },
  );
}

async function patchName(
  cookie: string,
  code: string,
  name: string,
): Promise<{ ok: boolean; http: number; detail?: string }> {
  const res = await fetch(`${SAP_BASE_URL}/ChartOfAccounts('${code}')`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Name: name }),
  });
  if (res.ok || res.status === 204) return { ok: true, http: res.status };
  const body = await res.text().catch(() => '');
  return { ok: false, http: res.status, detail: body.replace(/\s+/g, ' ').slice(0, 500) };
}

async function main(): Promise<void> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non défini dans .env');
  if (!SAP_PASSWORD) throw new Error('SAP_CLIENT_PASSWORD non défini dans .env');

  console.log('=== Correction des libellés ChartOfAccounts ===');
  console.log(`SL URL    : ${SAP_BASE_URL}`);
  console.log(`CompanyDB : ${SAP_CLIENT}`);
  console.log(`User      : ${SAP_USER}`);
  console.log(`Cibles    : ${RENAMES.length} compte(s)\n`);

  const cookie = await sapLogin();
  let okCount = 0;
  let koCount = 0;
  try {
    for (const { code, name } of RENAMES) {
      const r = await patchName(cookie, code, name);
      if (r.ok) {
        okCount++;
        console.log(`✅ ${code} → "${name}"`);
      } else {
        koCount++;
        console.log(`❌ Erreur sur ${code} [HTTP ${r.http}] : ${r.detail}`);
      }
    }
  } finally {
    await sapLogout(cookie);
  }

  console.log('');
  console.log(
    `${RENAMES.length} comptes à corriger — ${okCount} succès, ${koCount} erreur${koCount > 1 ? 's' : ''}`,
  );
  if (koCount > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('\nERREUR :', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
