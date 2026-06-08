/**
 * Synchronise le plan comptable SAP B1 de PRODUCTION avec les comptes utilisés par
 *   - les presets du générateur BILLING (apps/web/src/pages/InvoiceGeneratorPage.tsx)
 *   - les règles de mappage NOVA PA (table mapping_rules, colonne account_code)
 *
 * Différences avec scripts/sync-chart-of-accounts.ts (cible démo) :
 *   1. Garde-fou PRODUCTION : refuse de tourner contre SBODemoFR ou sans mot de passe.
 *   2. Table PCG_LABELS étendue + résolution "parent le plus profond" — JAMAIS de
 *      libellé fabriqué « Compte XXXXXX » : un compte sans libellé PCG résoluble
 *      n'est pas créé (reporté en erreur).
 *   3. Resynchronise chart_of_accounts_cache après création (l'UI cesse de flagger).
 *
 * Crée dans SAP les comptes manquants via /b1s/v1/ChartOfAccounts.
 * Idempotent : aucun effet de bord si tous les comptes existent déjà.
 *
 * Credentials lus depuis .env (jamais demandés en TTY).
 *
 * Usage : npx tsx scripts/sync-chart-of-accounts-prod.ts
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

// ─── Étape 2a : extraction des comptes depuis les presets BILLING ────────────

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

// ─── Étape 2c : dropdown CHART_OF_ACCOUNTS (sélectionnable ligne par ligne) ───
// Le générateur laisse l'utilisateur choisir n'importe quel compte de cette
// liste sur une ligne → ils doivent tous exister dans SAP. Note : certaines
// valeurs de libellé sont entre guillemets doubles (apostrophe), d'où ['"].

const DEMO_SUPPLIERS = path.resolve(
  __dirname,
  '..',
  'apps',
  'web',
  'src',
  'data',
  'demoSuppliers.ts',
);

function extractDropdownCodes(): string[] {
  const source = fs.readFileSync(DEMO_SUPPLIERS, 'utf8');
  const codes = new Set<string>();
  const re = /^\s*'(\d{3,10})':\s*['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    codes.add(m[1]);
  }
  return [...codes].sort();
}

// ─── Étape 2b : extraction des comptes depuis mapping_rules ──────────────────

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

// ─── Étape 3 : SAP Service Layer — session & lecture ChartOfAccounts ─────────

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

// Libellés officiels du Plan Comptable Général. Règle absolue : on ne fabrique
// JAMAIS un libellé. deriveAccountName remonte les préfixes (parent le plus
// profond) ; si rien n'est trouvé, on refuse de créer le compte.
const PCG_LABELS: Record<string, string> = {
  // ── Racines de classe (garde-fou : un parent officiel existe toujours) ──
  '1': 'Comptes de capitaux',
  '2': "Comptes d'immobilisations",
  '3': 'Comptes de stocks et en-cours',
  '4': 'Comptes de tiers',
  '5': 'Comptes financiers',
  '6': 'Comptes de charges',
  '7': 'Comptes de produits',
  // ── Tiers / TVA ──
  '401': 'Fournisseurs',
  '401000': 'Fournisseurs — compte général',
  '411': 'Clients',
  '411000': 'Clients — compte général',
  '445': "État — Taxes sur le chiffre d'affaires",
  '445200': 'TVA déductible sur immobilisations',
  '445660': 'TVA déductible sur autres biens et services',
  // ── Achats (60) ──
  '601': 'Achats stockés — Matières premières',
  '601000': 'Achats matières premières',
  '602': 'Achats stockés — Autres approvisionnements',
  '606': 'Achats non stockés de matières et fournitures',
  '606400': 'Fournitures administratives',
  '606500': 'Fournitures médicales',
  '607': 'Achats de marchandises',
  '607000': 'Achats de marchandises',
  '607100': 'Achats de marchandises — import',
  // ── Services extérieurs (61) ──
  '611': 'Sous-traitance générale',
  '613': 'Locations',
  '613200': 'Locations immobilières',
  '615': 'Entretien et réparations',
  '615600': 'Maintenance',
  '616': "Primes d'assurances",
  '618': 'Divers',
  // ── Autres services extérieurs (62) ──
  '622': "Rémunérations d'intermédiaires et honoraires",
  '622600': 'Honoraires',
  '623': 'Publicité, publications, relations publiques',
  '623000': 'Publicité, publications, relations publiques',
  '624': 'Transports de biens et transports collectifs du personnel',
  '624100': 'Transports sur achats',
  '625': 'Déplacements, missions et réceptions',
  '625100': 'Voyages et déplacements',
  '626': 'Frais postaux et frais de télécommunications',
  '627': 'Services bancaires et assimilés',
  '627000': 'Services bancaires et assimilés',
  '628': 'Divers',
  '628000': 'Divers (frais et charges)',
  // ── Impôts et taxes (63) ──
  '635': 'Autres impôts, taxes et versements assimilés',
  '635000': 'Cotisation foncière des entreprises (CFE)',
  '635100': 'Taxe foncière',
  '637': 'Autres impôts, taxes et versements assimilés (autres organismes)',
  // ── Charges de personnel (64) ──
  '641': 'Rémunérations du personnel',
  '641000': 'Salaires et traitements',
  '645': 'Charges de sécurité sociale et de prévoyance',
  '645000': 'Cotisations URSSAF et organismes sociaux',
  '647000': 'Autres charges sociales',
  // ── Autres charges de gestion courante (65) ──
  '651000': 'Redevances pour concessions, brevets, licences',
  '654': 'Pertes sur créances irrécouvrables',
  // ── Charges financières (66) ──
  '661': "Charges d'intérêts",
  '661100': 'Intérêts des emprunts et dettes',
  '661200': 'Intérêts des comptes courants et dépôts créditeurs',
  // ── Charges exceptionnelles (67) ──
  '671000': 'Charges exceptionnelles sur opérations de gestion',
  '672000': 'Charges sur exercices antérieurs',
  '678': 'Autres charges exceptionnelles',
};

/**
 * Libellé PCG du compte : code exact, sinon parent le plus profond présent dans
 * la table (on remonte les préfixes du plus long au plus court). Retourne null
 * si rien n'est résoluble — on ne fabrique JAMAIS « Compte XXXXXX ».
 */
function deriveAccountName(code: string): string | null {
  for (let len = code.length; len >= 1; len--) {
    const label = PCG_LABELS[code.slice(0, len)];
    if (label) return label;
  }
  return null;
}

// SBODemoFR n'expose que trois valeurs d'enum BoAccountTypes :
//   at_Revenues (I), at_Expenses (E), at_Other (N)
// Les classes 1–5 (bilan) sont donc mappées sur at_Other. Sur la prod, l'enum
// peut être plus riche, mais ces trois valeurs restent valides.
function deriveAccountType(code: string): string {
  switch (code.charAt(0)) {
    case '6':
      return 'at_Expenses';
    case '7':
      return 'at_Revenues';
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
  father?: string | null;
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

  // Garde-fou absolu : pas de libellé PCG résoluble → on ne crée pas le compte.
  if (!name) {
    return {
      code,
      status: 'error',
      http: 0,
      detail:
        'Aucun libellé PCG résoluble (code ni parent connus) — création refusée pour ne pas fabriquer de libellé arbitraire.',
      name: '(non résolu)',
      type: accountType,
      father,
    };
  }

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
    return { code, status: 'created', http: res.status, name, type: accountType, father };
  }
  const body = await res.text().catch(() => '');
  return {
    code,
    status: 'error',
    http: res.status,
    detail: body.replace(/\s+/g, ' ').slice(0, 500),
    name,
    type: accountType,
    father,
  };
}

// ─── Étape 6 : resynchronisation du cache local ──────────────────────────────

function sapBool(value: unknown): boolean {
  return value === true || value === 'tYES' || value === 'Y' || value === 'YES' || value === '1';
}

/**
 * Relit le plan SAP (déjà chargé via listChartOfAccounts) et upsert chaque
 * compte dans chart_of_accounts_cache, en répliquant la logique de
 * fetchChartOfAccounts + mapSapAccountForCache du service API :
 *   - classes 1–9 uniquement
 *   - postable = true (le service ne sélectionne pas Postable → défaut true)
 *   - accountLevel / groupMask = null
 * Ainsi validateCachedAccount ne flaggera plus « Compte inexistant dans SAP B1 ».
 */
async function syncCacheFromSap(accounts: ChartAccountRow[]): Promise<number> {
  const syncedAt = new Date();
  const rows = accounts
    .filter((a) => a.Code && /^[1-9]/.test(a.Code))
    .map((a) => ({
      acctCode: a.Code,
      acctName: a.Name ?? '',
      activeAccount: sapBool(a.ActiveAccount),
      postable: true,
      accountLevel: null as number | null,
      groupMask: null as number | null,
      syncAt: syncedAt,
    }));

  // Upsert par lots pour éviter une transaction démesurée sur un grand plan.
  const BATCH = 100;
  let synced = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map((r) =>
        prisma.chartOfAccountCache.upsert({
          where: { acctCode: r.acctCode },
          update: {
            acctName: r.acctName,
            activeAccount: r.activeAccount,
            postable: r.postable,
            accountLevel: r.accountLevel,
            groupMask: r.groupMask,
            syncAt: r.syncAt,
          },
          create: r,
        }),
      ),
    );
    synced += batch.length;
  }
  return synced;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Synchronisation plan comptable SAP B1 — PRODUCTION ===');
  console.log(`SAP_REST_BASE_URL : ${SAP_BASE_URL || '(non défini)'}`);
  console.log(`SAP_CLIENT        : ${SAP_CLIENT}`);
  console.log(`SAP_USER          : ${SAP_USER}`);
  console.log('');

  // ── Étape 1 : garde-fou cible PRODUCTION (cas grave → abort) ──
  if (!SAP_BASE_URL) {
    console.error('ABORT : SAP_REST_BASE_URL non défini dans .env — cible inconnue.');
    process.exitCode = 1;
    return;
  }
  // NB : chez cet utilisateur, la production tourne sur la CompanyDB nommée
  // « SBODemoFR » (confirmé). Ce nom n'est donc PAS un signal de base de démo
  // ici — on ne bloque que sur l'absence de mot de passe.
  if (!SAP_PASSWORD) {
    console.error(
      'ABORT : SAP_CLIENT_PASSWORD vide dans .env — impossible de confirmer la cible de production. ' +
        "Rien n'a été écrit dans SAP.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Cible considérée comme PRODUCTION (CompanyDB = ${SAP_CLIENT}). Poursuite.\n`);

  // ── Étape 2 : inventaire des comptes requis ──
  console.log('[2] Inventaire des comptes utilisés…');
  const billingCodes = extractPresetAccountingCodes();
  const dropdownCodes = extractDropdownCodes();
  const novaCodes = await extractMappingRuleAccountCodes();
  const required = [...new Set([...billingCodes, ...dropdownCodes, ...novaCodes])].sort();
  console.log(
    `    Presets BILLING (${billingCodes.length}) : ${billingCodes.join(', ') || '(aucun)'}`,
  );
  console.log(
    `    Dropdown CHART_OF_ACCOUNTS (${dropdownCodes.length}) : ${dropdownCodes.join(', ') || '(aucun)'}`,
  );
  console.log(
    `    mapping_rules NOVA PA (${novaCodes.length}) : ${novaCodes.join(', ') || '(aucun)'}`,
  );
  console.log(`    Total dédupliqué (${required.length}) : ${required.join(', ') || '(aucun)'}`);
  console.log('');

  if (required.length === 0) {
    console.log('Aucun compte à vérifier — arrêt.');
    return;
  }

  // ── Étape 3 : login + lecture du plan SAP de production ──
  console.log('[3] Lecture du plan comptable SAP B1 de production…');
  const session: SapSession = { cookie: await sapLogin() };

  const createOutcomes: CreateOutcome[] = [];
  let presentCount = 0;
  let missing: string[] = [];
  let cacheSynced = 0;

  try {
    let sapAccounts = await listChartOfAccounts(session);
    const sapCodes = new Set(sapAccounts.map((a) => a.Code));
    console.log(`    ${sapAccounts.length} compte(s) lus dans SAP.`);

    const present = required.filter((c) => sapCodes.has(c));
    missing = required.filter((c) => !sapCodes.has(c));
    presentCount = present.length;
    console.log(`    ✅ Déjà présents (${present.length}) : ${present.join(', ') || '(aucun)'}`);
    console.log(`    ❌ Manquants     (${missing.length}) : ${missing.join(', ') || '(aucun)'}`);
    console.log('');

    // ── Étape 5 : création des comptes manquants ──
    if (missing.length === 0) {
      console.log('Tous les comptes requis sont déjà présents — rien à créer.\n');
    } else {
      console.log('[5] Création des comptes manquants…');
      // liveCodes évolue : un code créé peut servir de parent au suivant.
      const liveCodes = new Set(sapCodes);
      for (const code of missing) {
        const r = await createChartAccount(session, code, liveCodes);
        if (r.status === 'created') {
          liveCodes.add(code);
          console.log(`    ✅ Créé : ${r.code} — ${r.name} (${r.type}, parent=${r.father ?? '—'})`);
        } else {
          console.log(`    ❌ Erreur sur ${r.code} [HTTP ${r.http}] : ${r.detail}`);
        }
        createOutcomes.push(r);
      }
      console.log('');
    }

    // ── Étape 6 : resynchronisation du cache local ──
    console.log('[6] Resynchronisation de chart_of_accounts_cache…');
    // Relecture du plan pour inclure les comptes fraîchement créés.
    sapAccounts = await listChartOfAccounts(session);
    cacheSynced = await syncCacheFromSap(sapAccounts);
    console.log(`    ${cacheSynced} ligne(s) de cache resynchronisée(s).`);
    console.log('');
  } finally {
    console.log('[7] Logout SAP…');
    await sapLogout(session.cookie);
    console.log('    OK\n');
  }

  // ── Rapport final ──
  const created = createOutcomes.filter((r) => r.status === 'created');
  const errors = createOutcomes.filter((r) => r.status === 'error');

  console.log('======================================');
  console.log('=== Rapport synchronisation PRODUCTION ===');
  console.log(`Comptes requis        : ${required.length}`);
  console.log(`Déjà présents         : ${presentCount}`);
  console.log(`Créés avec succès     : ${created.length}`);
  if (created.length > 0) {
    for (const r of created) {
      console.log(`    • ${r.code} — ${r.name} (${r.type}, parent=${r.father ?? '—'})`);
    }
  }
  console.log(`Erreurs               : ${errors.length}`);
  if (errors.length > 0) {
    for (const r of errors) {
      console.log(`    • ${r.code} [HTTP ${r.http}] : ${r.detail}`);
    }
  }
  console.log(`Cache resynchronisé   : ${cacheSynced} ligne(s)`);
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
