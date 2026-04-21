/**
 * Script de test d'authentification SAP B1
 * Usage : npx tsx scripts/test-sap-login.ts [--dry-run]
 *
 * Mode normal    : utilise les variables SAP réelles du .env
 * Mode --dry-run : vérifie uniquement la configuration, n'appelle pas SAP
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

// Bypass SSL pour le dev (certificat auto-signé SAP)
if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_LANG = process.env.SAP_LANG ?? 'FR';

interface TestCase {
  label: string;
  companyDb: string;
  userName: string;
  password: string;
}

const TEST_CASES: TestCase[] = [
  {
    label: 'SBODemoFR (principal)',
    companyDb: process.env.SAP_CLIENT ?? '',
    userName: process.env.SAP_USER ?? '',
    password: process.env.SAP_CLIENT_PASSWORD ?? '',
  },
  {
    label: 'RON_20260109 (Rondot)',
    companyDb: process.env.SAP_CLIENT_RONDOT ?? '',
    userName: process.env.SAP_USER_RONDOT ?? '',
    password: process.env.SAP_CLIENT_PASSWORD_RONDOT ?? '',
  },
];

function maskValue(value: string): string {
  if (!value) return '(vide)';
  if (value.length <= 4) return '****';
  return value.slice(0, 2) + '***' + value.slice(-2);
}

async function testLogin(tc: TestCase): Promise<void> {
  console.log(`\n  Société   : ${tc.companyDb || '(non défini)'}`);
  console.log(`  Utilisateur: ${tc.userName || '(non défini)'}`);
  console.log(`  Mot de passe: ${maskValue(tc.password)}`);

  if (!tc.companyDb || !tc.userName || !tc.password) {
    console.log('  → IGNORÉ : variables manquantes');
    return;
  }

  if (DRY_RUN) {
    console.log('  → DRY-RUN : appel SAP ignoré');
    return;
  }

  let response: Response;
  const t0 = Date.now();
  try {
    response = await fetch(`${SAP_BASE_URL}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CompanyDB: tc.companyDb,
        UserName: tc.userName,
        Password: tc.password,
        ...(Number.isNaN(Number(SAP_LANG)) ? {} : { Language: Number(SAP_LANG) }),
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  → ECHEC réseau : ${msg}`);
    return;
  }

  const elapsed = Date.now() - t0;
  const setCookie = response.headers.get('set-cookie') ?? '';
  const b1SessionMatch = setCookie.match(/B1SESSION=([^;,\s]+)/);
  const b1Session = b1SessionMatch?.[1] ?? null;

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const errMsg = (body?.error as Record<string, unknown> | undefined)?.message;
    const detail = typeof errMsg === 'object' ? JSON.stringify(errMsg) : String(errMsg ?? 'inconnu');
    console.log(`  → ECHEC SAP ${response.status} (${elapsed}ms) : ${detail}`);
    return;
  }

  if (!b1Session) {
    console.log(`  → ECHEC : HTTP ${response.status} mais B1SESSION absent du Set-Cookie`);
    return;
  }

  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const timeout = body.SessionTimeout;

  console.log(`  → OK (${elapsed}ms) — B1SESSION: ${maskValue(b1Session)} — timeout: ${timeout} min`);

  // Logout immédiat (best-effort)
  await fetch(`${SAP_BASE_URL}/Logout`, {
    method: 'POST',
    headers: { Cookie: `B1SESSION=${b1Session}` },
  }).then(() => {
    console.log('  → Logout effectué');
  }).catch(() => {
    console.log('  → Logout ignoré (SAP injoignable)');
  });
}

async function main(): Promise<void> {
  console.log('=== Test authentification SAP B1 ===');
  console.log(`URL de base : ${SAP_BASE_URL || '(non défini)'}`);
  console.log(`SSL bypass  : ${process.env.SAP_IGNORE_SSL === 'true' ? 'ACTIF (dev)' : 'inactif'}`);
  console.log(`Mode        : ${DRY_RUN ? 'DRY-RUN (pas d\'appel réel)' : 'RÉEL'}`);

  if (!SAP_BASE_URL) {
    console.error('\nERREUR : SAP_REST_BASE_URL non défini dans .env');
    process.exit(1);
  }

  for (const tc of TEST_CASES) {
    console.log(`\n[${tc.label}]`);
    await testLogin(tc);
  }

  console.log('\n=== Fin des tests ===');
}

main().catch((err: unknown) => {
  console.error('ERREUR inattendue :', err);
  process.exit(1);
});
