/**
 * Synchronise le plan comptable SAP B1 avec les comptes utilisés par
 *   - les presets du générateur BILLING (apps/web/src/pages/InvoiceGeneratorPage.tsx)
 *   - les règles de mappage NOVA PA (table mapping_rules, colonne account_code)
 *
 * Crée dans SAP les comptes manquants via /b1s/v1/ChartOfAccounts.
 * Script idempotent : aucun effet de bord si tous les comptes existent déjà.
 *
 * Credentials lus depuis .env (jamais demandés en TTY).
 *
 * Usage : npx tsx scripts/sync-chart-of-accounts.ts
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_CLIENT = process.env.SAP_CLIENT ?? 'SBODemoFR';
const SAP_USER = process.env.SAP_USER ?? 'manager';
const SAP_PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';

const prisma = new PrismaClient();

// ─── Étape 1a : extraction des comptes depuis les presets BILLING ────────────

const GENERATOR_PAGE = path.resolve(
  __dirname,
  '..',
  'apps',
  'web',
  'src',
  'pages',
  'InvoiceGeneratorPage.tsx',
);

function extractPresetAccountingCodes(): string[] {
  const source = fs.readFileSync(GENERATOR_PAGE, 'utf8');
  const codes = new Set<string>();
  const re = /accountingCode:\s*['"`](\d{3,10})['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    codes.add(m[1]);
  }
  return [...codes].sort();
}

// ─── Étape 1b : extraction des comptes depuis mapping_rules ──────────────────

async function extractMappingRuleAccountCodes(): Promise<string[]> {
  const rows = await prisma.mappingRule.findMany({
    select: { accountCode: true },
    distinct: ['accountCode'],
  });
  const codes = new Set<string>();
  for (const r of rows) {
    const c = (r.accountCode ?? '').trim();
    if (c) codes.add(c);
  }
  return [...codes].sort();
}

// ─── Étape 2 : SAP Service Layer — session & lecture ChartOfAccounts ─────────

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

interface ChartAccountRow {
  Code: string;
  Name?: string;
  AccountType?: string;
  Level?: number;
  ActiveAccount?: string | boolean;
}

interface SapSession {
  cookie: string;
}

async function sapFetch(
  session: SapSession,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = { ...(init.headers ?? {}), Cookie: session.cookie } as Record<string, string>;
  let res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // session expirée : ré-authentifier puis rejouer une fois
    session.cookie = await sapLogin();
    headers.Cookie = session.cookie;
    res = await fetch(url, { ...init, headers });
  }
  return res;
}

async function listChartOfAccounts(session: SapSession): Promise<ChartAccountRow[]> {
  const all: ChartAccountRow[] = [];
  const PAGE_SIZE = 500;
  let url: string | null =
    `${SAP_BASE_URL}/ChartOfAccounts?$select=Code,Name,AccountType,ActiveAccount`;
  let page = 0;
  while (url && page < 200) {
    page++;
    const res = await sapFetch(session, url, {
      headers: { Prefer: `odata.maxpagesize=${PAGE_SIZE}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ChartOfAccounts (${res.status}) : ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      value?: ChartAccountRow[];
      'odata.nextLink'?: string;
      '@odata.nextLink'?: string;
    };
    all.push(...(json.value ?? []));
    const next = json['@odata.nextLink'] ?? json['odata.nextLink'];
    if (next) {
      url = next.startsWith('http') ? next : `${SAP_BASE_URL}/${next.replace(/^\//, '')}`;
    } else {
      url = null;
    }
  }
  return all;
}

// ─── Étape 4 : dérivation type + libellé PCG ─────────────────────────────────

const PCG_LABELS: Record<string, string> = {
  '401': 'Fournisseurs',
  '401000': 'Fournisseurs — compte général',
  '411': 'Clients',
  '411000': 'Clients — compte général',
  '445': "État — Taxes sur le chiffre d'affaires",
  '445200': 'TVA déductible sur immobilisations',
  '445660': 'TVA déductible sur autres biens et services',
  '601': 'Achats stockés — Matières premières',
  '601000': 'Achats matières premières',
  '607': 'Achats de marchandises',
  '607000': 'Achats de marchandises',
  '607100': 'Achats de marchandises — import',
  '611': 'Sous-traitance générale',
  '613': 'Locations',
  '615': 'Entretien et réparations',
  '622': "Rémunérations d'intermédiaires et honoraires",
  '625': 'Déplacements, missions et réceptions',
  '626': 'Frais postaux et frais de télécommunications',
  '627': 'Services bancaires et assimilés',
  '628': 'Divers',
  '635': 'Autres impôts, taxes et versements assimilés',
  '635000': 'Cotisation foncière des entreprises (CFE)',
  '635100': 'Taxe foncière',
  '641': 'Rémunérations du personnel',
  '641000': 'Salaires et traitements',
  '645': 'Charges de sécurité sociale et de prévoyance',
  '661': "Charges d'intérêts",
  '661100': 'Intérêts des emprunts et dettes',
  // Libellés ajoutés après PATCH manuel (rename-chart-of-accounts.ts) :
  '606500': 'Fournitures médicales',
  '627000': 'Services bancaires et assimilés',
  '628000': 'Divers (frais et charges)',
  '645000': 'Cotisations URSSAF et organismes sociaux',
  '647000': 'Autres charges sociales',
  '651000': 'Redevances pour concessions, brevets, licences',
  '661200': 'Intérêts des comptes courants et dépôts créditeurs',
  '671000': 'Charges exceptionnelles sur opérations de gestion',
  '672000': 'Charges sur exercices antérieurs',
};

function deriveAccountName(code: string): string {
  if (PCG_LABELS[code]) return PCG_LABELS[code];
  const p3 = code.slice(0, 3);
  if (PCG_LABELS[p3]) return PCG_LABELS[p3];
  const p1 = code.slice(0, 1);
  if (PCG_LABELS[p1]) return PCG_LABELS[p1];
  return `Compte ${code}`;
}

// SBODemoFR n'expose que trois valeurs d'enum BoAccountTypes :
//   at_Revenues (I), at_Expenses (E), at_Other (N)
// Les classes 1–5 (bilan) sont donc mappées sur at_Other.
function deriveAccountType(code: string): string {
  const c = code.charAt(0);
  switch (c) {
    case '6':
      return 'at_Expenses';
    case '7':
      return 'at_Revenues';
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
      return 'at_Other';
    default:
      return 'at_Other';
  }
}

interface CreateOutcome {
  code: string;
  status: 'created' | 'error';
  http: number;
  detail?: string;
  name: string;
  type: string;
}

// Recherche du parent le plus profond existant dans SAP, en remontant les
// préfixes du code. Ex. pour 635100 : 63510, 6351, 635, 63, 6.
function findFatherAccountKey(code: string, sapCodes: Set<string>): string | null {
  for (let len = code.length - 1; len >= 1; len--) {
    const prefix = code.slice(0, len);
    if (sapCodes.has(prefix)) return prefix;
  }
  return null;
}

async function createChartAccount(
  session: SapSession,
  code: string,
  sapCodes: Set<string>,
): Promise<CreateOutcome> {
  const name = deriveAccountName(code);
  const accountType = deriveAccountType(code);
  const father = findFatherAccountKey(code, sapCodes);
  const payload: Record<string, unknown> = {
    Code: code,
    Name: name,
    AccountType: accountType,
    ActiveAccount: 'tYES',
  };
  if (father) payload.FatherAccountKey = father;

  const res = await sapFetch(session, `${SAP_BASE_URL}/ChartOfAccounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 201 || res.ok) {
    return { code, status: 'created', http: res.status, name, type: accountType };
  }
  const body = await res.text().catch(() => '');
  return {
    code,
    status: 'error',
    http: res.status,
    detail: body.replace(/\s+/g, ' ').slice(0, 500),
    name,
    type: accountType,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non défini dans .env');
  if (!SAP_PASSWORD) {
    throw new Error(
      'SAP_CLIENT_PASSWORD non défini dans .env — décommentez la ligne SAP_CLIENT_PASSWORD avant de relancer.',
    );
  }

  console.log('=== Synchronisation plan comptable SAP B1 ===');
  console.log(`SL URL    : ${SAP_BASE_URL}`);
  console.log(`CompanyDB : ${SAP_CLIENT}`);
  console.log(`User      : ${SAP_USER}`);
  console.log('');

  // Étape 1
  console.log('[1/4] Inventaire des comptes utilisés…');
  const billingCodes = extractPresetAccountingCodes();
  const novaCodes = await extractMappingRuleAccountCodes();
  const required = [...new Set([...billingCodes, ...novaCodes])].sort();
  console.log(
    `      Presets BILLING (${billingCodes.length}) : ${billingCodes.join(', ') || '(aucun)'}`,
  );
  console.log(
    `      mapping_rules NOVA PA (${novaCodes.length}) : ${novaCodes.join(', ') || '(aucun)'}`,
  );
  console.log(`      Total dédupliqué (${required.length}) : ${required.join(', ') || '(aucun)'}`);
  console.log('');

  if (required.length === 0) {
    console.log('Aucun compte à vérifier — arrêt.');
    return;
  }

  // Étape 2 + 3 : login + lecture du plan SAP
  console.log('[2/4] Lecture du plan comptable SAP B1…');
  const session: SapSession = { cookie: await sapLogin() };

  const createOutcomes: CreateOutcome[] = [];
  let presentCount = 0;
  let missing: string[] = [];

  try {
    const sapAccounts = await listChartOfAccounts(session);
    const sapCodes = new Set(sapAccounts.map((a) => a.Code));
    console.log(`      ${sapAccounts.length} compte(s) lus dans SAP.`);

    const present = required.filter((c) => sapCodes.has(c));
    missing = required.filter((c) => !sapCodes.has(c));
    presentCount = present.length;
    console.log(`      ✅ Déjà présents (${present.length}) : ${present.join(', ') || '(aucun)'}`);
    console.log(`      ❌ Manquants     (${missing.length}) : ${missing.join(', ') || '(aucun)'}`);
    console.log('');

    if (missing.length === 0) {
      console.log('Tous les comptes sont déjà présents — rien à créer.\n');
    } else {
      // Étape 4 : création
      console.log('[3/4] Création des comptes manquants…');
      // sapCodes évolue : on ajoute chaque code créé pour qu'un compte de la
      // même branche puisse servir de parent au suivant.
      const liveCodes = new Set(sapCodes);
      for (const code of missing) {
        const r = await createChartAccount(session, code, liveCodes);
        if (r.status === 'created') {
          liveCodes.add(code);
          console.log(`      ✅ Créé : ${r.code} — ${r.name} (${r.type})`);
        } else {
          console.log(`      ❌ Erreur sur ${r.code} [HTTP ${r.http}] : ${r.detail}`);
        }
        createOutcomes.push(r);
      }
      console.log('');
    }
  } finally {
    console.log('[4/4] Logout SAP…');
    await sapLogout(session.cookie);
    console.log('      OK\n');
  }

  // Récap
  const created = createOutcomes.filter((r) => r.status === 'created').length;
  const errors = createOutcomes.filter((r) => r.status === 'error');

  console.log('======================================');
  console.log('=== Synchronisation plan comptable SAP B1 ===');
  console.log(`Comptes requis    : ${required.length}`);
  console.log(`Déjà présents     : ${presentCount}`);
  console.log(`Créés avec succès : ${created}`);
  console.log(`Erreurs           : ${errors.length}`);
  console.log('======================================');

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error('\nERREUR :', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {
      /* ignore */
    });
  });
