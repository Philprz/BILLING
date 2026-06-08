/**
 * AUDIT (lecture seule) : tous les comptes que le générateur de facture PEUT
 * utiliser existent-ils dans SAP B1 ?
 *   - presets PRESETS[].lines[].accountingCode  (InvoiceGeneratorPage.tsx)
 *   - dropdown CHART_OF_ACCOUNTS                 (data/demoSuppliers.ts)
 *   - comptes de TVA déductible (VatGroupCache.taxAccount, ex. 445660)
 *   - comptes mapping_rules.account_code
 * N'écrit RIEN dans SAP.
 *
 * Usage : npx tsx scripts/check-generator-accounts.ts
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
if (process.env.SAP_IGNORE_SSL === 'true') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_CLIENT = process.env.SAP_CLIENT ?? 'SBODemoFR';
const SAP_USER = process.env.SAP_USER ?? 'manager';
const SAP_PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';
const prisma = new PrismaClient();

const ROOT = path.resolve(__dirname, '..');

function readCodes(file: string, re: RegExp): string[] {
  const src = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const s = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) s.add(m[1]);
  return [...s].sort();
}

function cookie(res: Response): string | null {
  const map = new Map<string, string>();
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const h of raw) {
    if (!h) continue;
    for (const n of ['B1SESSION', 'ROUTEID', 'HASH_B1SESSION']) {
      const mm = h.match(new RegExp(`${n}=([^;,\\s]+)`));
      if (mm?.[1]) map.set(n, mm[1]);
    }
  }
  if (!map.has('B1SESSION')) return null;
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

async function listSapCodes(ck: string): Promise<Set<string>> {
  const codes = new Set<string>();
  let url: string | null = `${SAP_BASE_URL}/ChartOfAccounts?$select=Code`;
  let page = 0;
  while (url && page < 200) {
    page++;
    const res = await fetch(url, {
      headers: { Cookie: ck, Prefer: 'odata.maxpagesize=500' },
    });
    if (!res.ok) throw new Error(`GET ChartOfAccounts ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as {
      value?: { Code: string }[];
      'odata.nextLink'?: string;
      '@odata.nextLink'?: string;
    };
    for (const r of j.value ?? []) codes.add(r.Code);
    const next = j['@odata.nextLink'] ?? j['odata.nextLink'];
    url = next
      ? next.startsWith('http')
        ? next
        : `${SAP_BASE_URL}/${next.replace(/^\//, '')}`
      : null;
  }
  return codes;
}

function report(label: string, codes: string[], sap: Set<string>) {
  const missing = codes.filter((c) => !sap.has(c));
  const present = codes.filter((c) => sap.has(c));
  console.log(`\n── ${label} : ${codes.length} code(s) ──`);
  console.log(`   ✅ présents (${present.length}) : ${present.join(', ') || '—'}`);
  console.log(`   ❌ MANQUANTS (${missing.length}) : ${missing.join(', ') || '—'}`);
  return missing;
}

async function main() {
  const presets = readCodes(
    'apps/web/src/pages/InvoiceGeneratorPage.tsx',
    /accountingCode:\s*['"`](\d{3,10})['"`]/g,
  );
  // Bloc CHART_OF_ACCOUNTS : clés '601000': '...'
  const dropdown = readCodes('apps/web/src/data/demoSuppliers.ts', /^\s*'(\d{3,10})':\s*['"]/gm);

  const mr = await prisma.mappingRule.findMany({
    select: { accountCode: true },
    distinct: ['accountCode'],
  });
  const mapping = [...new Set(mr.map((r) => (r.accountCode ?? '').trim()).filter(Boolean))].sort();

  const vat = await prisma.vatGroupCache.findMany({ select: { taxAccount: true } });
  const vatAccts = [...new Set(vat.map((v) => (v.taxAccount ?? '').trim()).filter(Boolean))].sort();

  console.log('=== AUDIT comptes générateur vs SAP B1 ===');
  console.log(`CompanyDB : ${SAP_CLIENT}\n`);

  const login = await fetch(`${SAP_BASE_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_CLIENT, UserName: SAP_USER, Password: SAP_PASSWORD }),
  });
  const ck = cookie(login);
  if (!ck) throw new Error(`Login KO ${login.status}: ${await login.text()}`);

  const allMissing: string[] = [];
  try {
    const sap = await listSapCodes(ck);
    console.log(`Plan SAP : ${sap.size} compte(s) lus.`);
    allMissing.push(...report('Presets générateur (accountingCode)', presets, sap));
    allMissing.push(...report('Dropdown CHART_OF_ACCOUNTS', dropdown, sap));
    allMissing.push(...report('mapping_rules.account_code', mapping, sap));
    allMissing.push(...report('Comptes TVA (VatGroupCache.taxAccount)', vatAccts, sap));
  } finally {
    await fetch(`${SAP_BASE_URL}/Logout`, { method: 'POST', headers: { Cookie: ck } }).catch(
      () => {},
    );
  }

  const uniqueMissing = [...new Set(allMissing)].sort();
  console.log('\n======================================');
  console.log(`TOTAL comptes manquants (dédupliqués) : ${uniqueMissing.length}`);
  console.log(uniqueMissing.join(', ') || '— aucun —');
  console.log('======================================');
}

main()
  .catch((e) => {
    console.error('ERREUR', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
