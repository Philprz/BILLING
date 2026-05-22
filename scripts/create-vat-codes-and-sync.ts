/**
 * Crée les codes TVA S0–S4 dans SAP B1 (CompanyDB SBODemoFR) puis
 * resynchronise la table vat_group_cache de NOVA-PA.
 *
 * Le mot de passe SAP est demandé interactivement (stdin TTY, écho masqué) —
 * il n'est jamais écrit dans .env ni journalisé.
 *
 * Usage : npx tsx scripts/create-vat-codes-and-sync.ts
 */
import path from 'path';
import dotenv from 'dotenv';
import readline from 'readline';
import { PrismaClient, Prisma } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_CLIENT = 'SBODemoFR';
const SAP_USER = process.env.SAP_USER ?? 'manager';

interface VatGroupPayload {
  Code: string;
  Name: string;
  Category: string;
  Inactive: string;
  VatGroups_Lines: { Effectivefrom: string; Rate: number }[];
}

const VAT_EFFECTIVE_FROM = '2020-01-01T00:00:00Z';

const VAT_CODES_TO_CREATE: VatGroupPayload[] = [
  {
    Code: 'S0',
    Name: 'TVA 0%',
    Category: 'bovcInputTax',
    Inactive: 'tNO',
    VatGroups_Lines: [{ Effectivefrom: VAT_EFFECTIVE_FROM, Rate: 0 }],
  },
  {
    Code: 'S1',
    Name: 'TVA 20%',
    Category: 'bovcInputTax',
    Inactive: 'tNO',
    VatGroups_Lines: [{ Effectivefrom: VAT_EFFECTIVE_FROM, Rate: 20 }],
  },
  {
    Code: 'S2',
    Name: 'TVA 10%',
    Category: 'bovcInputTax',
    Inactive: 'tNO',
    VatGroups_Lines: [{ Effectivefrom: VAT_EFFECTIVE_FROM, Rate: 10 }],
  },
  {
    Code: 'S3',
    Name: 'TVA 5.5%',
    Category: 'bovcInputTax',
    Inactive: 'tNO',
    VatGroups_Lines: [{ Effectivefrom: VAT_EFFECTIVE_FROM, Rate: 5.5 }],
  },
  {
    Code: 'S4',
    Name: 'TVA 2.1%',
    Category: 'bovcInputTax',
    Inactive: 'tNO',
    VatGroups_Lines: [{ Effectivefrom: VAT_EFFECTIVE_FROM, Rate: 2.1 }],
  },
];

const prisma = new PrismaClient();

// ─── Prompt mot de passe masqué (stdin TTY) ──────────────────────────────────
// Codes de contrôle ASCII manipulés via charCodeAt pour éviter tout littéral
// de caractère non imprimable dans le source.
const CC_ETX = 0x03; // Ctrl+C
const CC_EOT = 0x04; // Ctrl+D
const CC_BS = 0x08; // Backspace
const CC_LF = 0x0a; // \n
const CC_CR = 0x0d; // \r
const CC_DEL = 0x7f; // Backspace (TTY)

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    let pwd = '';
    const onData = (chunk: string): void => {
      const s = chunk.toString();
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code === CC_LF || code === CC_CR || code === CC_EOT) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(pwd);
          return;
        }
        if (code === CC_ETX) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          reject(new Error('Annulé par l’utilisateur (Ctrl+C)'));
          return;
        }
        if (code === CC_BS || code === CC_DEL) {
          pwd = pwd.slice(0, -1);
          continue;
        }
        pwd += s.charAt(i);
      }
    };
    stdin.on('data', onData);
  });
}

// ─── Cookies SAP ─────────────────────────────────────────────────────────────

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

// ─── Service Layer ───────────────────────────────────────────────────────────

async function sapLogin(password: string): Promise<string> {
  const res = await fetch(`${SAP_BASE_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_CLIENT, UserName: SAP_USER, Password: password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Login SAP échoué (${res.status}) : ${body}`);
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

interface SapVatGroupRow {
  Code: string;
  Name: string;
  Category?: string | null;
  TaxAccount?: string | null;
  Inactive?: string | boolean;
  Active?: string | boolean;
  VatGroups_Lines?: { Rate?: number; RateFC?: number }[];
  Rate?: number;
  [key: string]: unknown;
}

async function listVatGroups(cookie: string): Promise<SapVatGroupRow[]> {
  const all: SapVatGroupRow[] = [];
  let url: string | null = `${SAP_BASE_URL}/VatGroups?$top=100`;
  let page = 0;
  while (url && page < 100) {
    page++;
    const res: Response = await fetch(url, { headers: { Cookie: cookie } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET VatGroups (${res.status}) : ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      value?: SapVatGroupRow[];
      'odata.nextLink'?: string;
      '@odata.nextLink'?: string;
    };
    all.push(...(json.value ?? []));
    const next = json['@odata.nextLink'] ?? json['odata.nextLink'];
    if (next) {
      url = next.startsWith('http')
        ? next
        : `${SAP_BASE_URL.replace(/\/VatGroups.*/, '')}/${next.replace(/^\//, '')}`;
    } else {
      url = null;
    }
  }
  return all;
}

interface CreateResult {
  code: string;
  status: 'created' | 'exists' | 'error';
  http: number;
  detail?: string;
}

async function createVatGroup(cookie: string, payload: VatGroupPayload): Promise<CreateResult> {
  const res = await fetch(`${SAP_BASE_URL}/VatGroups`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 201 || res.ok) {
    return { code: payload.Code, status: 'created', http: res.status };
  }
  const body = await res.text().catch(() => '');
  const lower = body.toLowerCase();
  if (
    res.status === 409 ||
    lower.includes('already exists') ||
    lower.includes('duplicate') ||
    lower.includes('-2035')
  ) {
    return { code: payload.Code, status: 'exists', http: res.status, detail: body.slice(0, 300) };
  }
  return { code: payload.Code, status: 'error', http: res.status, detail: body.slice(0, 800) };
}

// ─── Sync NOVA-PA (vat_group_cache) ──────────────────────────────────────────

function parseSapActive(r: SapVatGroupRow): boolean {
  const inactive = r.Inactive;
  if (inactive !== undefined) {
    if (typeof inactive === 'boolean') return !inactive;
    if (inactive === 'tYES' || inactive === 'Y' || inactive === 'YES') return false;
    if (inactive === 'tNO' || inactive === 'N' || inactive === 'NO') return true;
  }
  const active = r.Active;
  if (active !== undefined) {
    if (typeof active === 'boolean') return active;
    if (active === 'tYES') return true;
    if (active === 'tNO') return false;
  }
  return true;
}

function extractRate(r: SapVatGroupRow): number {
  let rateRaw: unknown = r.Rate;
  if (rateRaw == null && Array.isArray(r.VatGroups_Lines) && r.VatGroups_Lines.length > 0) {
    const first = r.VatGroups_Lines[0];
    rateRaw = first.Rate ?? first.RateFC;
  }
  if (typeof rateRaw === 'number') return rateRaw;
  const n = parseFloat(String(rateRaw ?? 0));
  return Number.isNaN(n) ? 0 : n;
}

async function syncVatCache(rows: SapVatGroupRow[]): Promise<number> {
  const syncedAt = new Date();
  await prisma.$transaction(
    rows.map((r) =>
      prisma.vatGroupCache.upsert({
        where: { code: r.Code },
        update: {
          name: r.Name,
          rate: extractRate(r),
          active: parseSapActive(r),
          category: typeof r.Category === 'string' ? r.Category : null,
          taxAccount: typeof r.TaxAccount === 'string' ? r.TaxAccount : null,
          raw: r as unknown as Prisma.InputJsonValue,
          syncAt: syncedAt,
        },
        create: {
          code: r.Code,
          name: r.Name,
          rate: extractRate(r),
          active: parseSapActive(r),
          category: typeof r.Category === 'string' ? r.Category : null,
          taxAccount: typeof r.TaxAccount === 'string' ? r.TaxAccount : null,
          raw: r as unknown as Prisma.InputJsonValue,
          syncAt: syncedAt,
        },
      }),
    ),
  );
  return rows.length;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non défini dans .env');
  console.log('=== Création codes TVA S0–S4 + resync NOVA-PA ===');
  console.log(`SL URL    : ${SAP_BASE_URL}`);
  console.log(`CompanyDB : ${SAP_CLIENT}`);
  console.log(`User      : ${SAP_USER}`);
  console.log('');

  const password = await promptPassword(`Mot de passe SAP pour ${SAP_USER}@${SAP_CLIENT} : `);
  if (!password) throw new Error('Mot de passe vide');

  console.log('[1/6] Login SAP…');
  const cookie = await sapLogin(password);
  console.log('      OK\n');

  const createResults: CreateResult[] = [];
  let finalRows: SapVatGroupRow[] = [];
  let synced = 0;

  try {
    console.log('[2/6] Lecture des VatGroups existants…');
    const existing = await listVatGroups(cookie);
    const existingCodes = new Set(existing.map((r) => r.Code));
    console.log(`      ${existing.length} groupe(s) TVA présent(s) dans SAP.`);
    // Diagnostic : structure réelle d'un VatGroup pour cette instance SAP.
    if (existing.length > 0) {
      const sample = existing[0];
      const topKeys = Object.keys(sample).filter((k) => !k.startsWith('@'));
      console.log(`      Clés VatGroup    : ${topKeys.join(', ')}`);
      const lines = sample.VatGroups_Lines;
      if (Array.isArray(lines) && lines.length > 0) {
        const lineKeys = Object.keys(lines[0]).filter((k) => !k.startsWith('@'));
        console.log(`      Clés VatGroups_Line: ${lineKeys.join(', ')}`);
        console.log(`      Exemple ligne    : ${JSON.stringify(lines[0])}`);
      } else {
        console.log('      VatGroups_Lines  : (absent du payload de lecture)');
      }
    }
    const toCreate = VAT_CODES_TO_CREATE.filter((p) => !existingCodes.has(p.Code));
    const alreadyPresent = VAT_CODES_TO_CREATE.filter((p) => existingCodes.has(p.Code)).map(
      (p) => p.Code,
    );
    if (alreadyPresent.length > 0) {
      console.log(`      Déjà présents (ignorés au POST) : ${alreadyPresent.join(', ')}`);
    }
    console.log(`      À créer : ${toCreate.map((p) => p.Code).join(', ') || '(aucun)'}\n`);

    console.log('[3/6] Création des codes manquants…');
    for (const payload of toCreate) {
      const r = await createVatGroup(cookie, payload);
      const tag =
        r.status === 'created' ? '✓ créé' : r.status === 'exists' ? '• existait déjà' : '✗ erreur';
      console.log(`      ${payload.Code} → HTTP ${r.http} ${tag}`);
      if (r.status === 'error' && r.detail) {
        console.log(`         detail: ${r.detail.replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      createResults.push(r);
    }
    for (const code of alreadyPresent) {
      createResults.push({ code, status: 'exists', http: 200 });
    }
    console.log('');

    console.log('[4/6] Relecture des VatGroups (vérification)…');
    finalRows = await listVatGroups(cookie);
    console.log(`      ${finalRows.length} groupe(s) TVA dans SAP après opération.\n`);

    console.log('[5/6] Resync vat_group_cache (NOVA-PA)…');
    synced = await syncVatCache(finalRows);
    console.log(`      ${synced} ligne(s) upserties en base NOVA-PA.\n`);
  } finally {
    console.log('[6/6] Logout SAP…');
    await sapLogout(cookie);
    console.log('      OK\n');
  }

  console.log('=== RÉCAP ===');
  const created = createResults.filter((r) => r.status === 'created').map((r) => r.code);
  const exists = createResults.filter((r) => r.status === 'exists').map((r) => r.code);
  const errors = createResults.filter((r) => r.status === 'error');
  console.log(`Codes créés         : ${created.length ? created.join(', ') : '(aucun)'}`);
  console.log(`Codes déjà présents : ${exists.length ? exists.join(', ') : '(aucun)'}`);
  console.log(
    `Erreurs             : ${
      errors.length ? errors.map((e) => `${e.code} [HTTP ${e.http}]`).join(', ') : '(aucune)'
    }`,
  );

  const targets = ['S0', 'S1', 'S2', 'S3', 'S4'];
  const presentFinal = new Set(finalRows.map((r) => r.Code));
  const missing = targets.filter((c) => !presentFinal.has(c));
  console.log(
    `Vérif finale S0–S4  : ${
      missing.length === 0 ? 'tous présents dans SAP ✓' : `MANQUANTS : ${missing.join(', ')} ✗`
    }`,
  );
  console.log(
    `Resync NOVA-PA      : ${synced > 0 && errors.length === 0 ? 'OK' : synced > 0 ? 'OK (avec erreurs côté SAP)' : 'KO'}`,
  );

  if (finalRows.length > 0) {
    console.log('\nDétail des codes S0–S4 dans SAP :');
    for (const code of targets) {
      const r = finalRows.find((x) => x.Code === code);
      if (!r) {
        console.log(`  ${code} : (absent)`);
        continue;
      }
      const rate = extractRate(r);
      const active = parseSapActive(r);
      console.log(`  ${code} : ${r.Name} — ${rate}% — ${active ? 'actif' : 'inactif'}`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error('\nERREUR :', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {
      /* ignore */
    });
  });
