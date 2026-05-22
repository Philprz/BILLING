/**
 * Pousse le FederalTaxID (TVA intra) depuis supplier_cache NOVA-PA vers
 * les Business Partners SAP B1, uniquement quand SAP est vide.
 *
 * - Source NOVA-PA : suppliers_cache.federaltaxid (mappé sur SAP BP.FederalTaxID).
 * - Idempotent : si SAP a déjà une valeur, on saute (jamais d'écrasement).
 * - Mot de passe SAP saisi en TTY masqué, jamais persisté.
 *
 * Usage :
 *   npx tsx scripts/push-federal-tax-id-to-sap.ts            # exécution réelle
 *   npx tsx scripts/push-federal-tax-id-to-sap.ts --dry-run  # plan uniquement, aucun PATCH ni resync
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
const SAP_CLIENT = process.env.SAP_CLIENT ?? 'SBODemoFR';
const SAP_USER = process.env.SAP_USER ?? 'manager';
const DRY_RUN = process.argv.includes('--dry-run');

const prisma = new PrismaClient();

// ─── Prompt mot de passe masqué (stdin TTY) ──────────────────────────────────
const CC_ETX = 0x03;
const CC_EOT = 0x04;
const CC_BS = 0x08;
const CC_LF = 0x0a;
const CC_CR = 0x0d;
const CC_DEL = 0x7f;

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

// ─── SAP Service Layer ───────────────────────────────────────────────────────

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

function encodeBpKey(cardCode: string): string {
  return encodeURIComponent(`'${cardCode.replace(/'/g, "''")}'`);
}

interface SapBpView {
  CardCode: string;
  CardName: string;
  FederalTaxID: string | null;
}

async function getBpFederalTaxId(
  cookie: string,
  cardCode: string,
): Promise<SapBpView | { notFound: true }> {
  const url = `${SAP_BASE_URL}/BusinessPartners(${encodeBpKey(cardCode)})?$select=CardCode,CardName,FederalTaxID`;
  const res = await fetch(url, { headers: { Cookie: cookie } });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET BP ${cardCode} (${res.status}) : ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as Partial<SapBpView>;
  return {
    CardCode: json.CardCode ?? cardCode,
    CardName: json.CardName ?? '',
    FederalTaxID:
      typeof json.FederalTaxID === 'string' && json.FederalTaxID.trim().length > 0
        ? json.FederalTaxID.trim()
        : null,
  };
}

interface PatchResult {
  http: number;
  ok: boolean;
  detail?: string;
}

async function patchBpFederalTaxId(
  cookie: string,
  cardCode: string,
  federalTaxId: string,
): Promise<PatchResult> {
  const res = await fetch(`${SAP_BASE_URL}/BusinessPartners(${encodeBpKey(cardCode)})`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ FederalTaxID: federalTaxId }),
  });
  if (res.ok || res.status === 204) return { http: res.status, ok: true };
  const body = await res.text().catch(() => '');
  return { http: res.status, ok: false, detail: body.slice(0, 400) };
}

// ─── Resync supplier_cache depuis SAP (toutes les pages) ─────────────────────

interface SapSupplier {
  CardCode: string;
  CardName: string;
  CardType: string;
  FederalTaxID: string | null;
  VATRegistrationNumber: string | null;
}

async function fetchAllSuppliers(cookie: string): Promise<SapSupplier[]> {
  const PAGE = 100;
  const all: SapSupplier[] = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      $filter: "CardType eq 'cSupplier'",
      $select: 'CardCode,CardName,CardType,FederalTaxID,VATRegistrationNumber',
      $top: String(PAGE),
      $skip: String(skip),
      $orderby: 'CardCode',
    });
    const res = await fetch(`${SAP_BASE_URL}/BusinessPartners?${params}`, {
      headers: { Cookie: cookie, Prefer: 'odata.maxpagesize=100' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sync BP (${res.status}) : ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { value?: SapSupplier[] };
    const page = json.value ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

async function resyncSupplierCache(cookie: string): Promise<number> {
  const suppliers = await fetchAllSuppliers(cookie);
  const now = new Date();
  let n = 0;
  for (const s of suppliers) {
    const data = {
      cardname: s.CardName,
      cardtype: s.CardType,
      federaltaxid: s.FederalTaxID?.trim() || null,
      vatregnum: s.VATRegistrationNumber?.trim() || null,
      lastSyncAt: now,
      syncAt: now,
    };
    await prisma.supplierCache.upsert({
      where: { cardcode: s.CardCode },
      update: data,
      create: {
        cardcode: s.CardCode,
        ...data,
        rawPayload: s as unknown as Prisma.InputJsonValue,
      },
    });
    n++;
  }
  return n;
}

// ─── Helpers tableau ─────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len - 1) + '…';
  return s + ' '.repeat(len - s.length);
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface PlanEntry {
  cardcode: string;
  cardname: string;
  novaFederalTaxId: string;
  sapFederalTaxId: string | null;
  bucket: 'A_already_set' | 'B_to_push' | 'C_no_source' | 'D_sap_not_found';
}

interface PushOutcome {
  cardcode: string;
  cardname: string;
  vat: string;
  http: number;
  ok: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  if (!SAP_BASE_URL) throw new Error('SAP_REST_BASE_URL non défini dans .env');
  console.log('=== Push FederalTaxID NOVA-PA → SAP B1 ===');
  console.log(`SL URL    : ${SAP_BASE_URL}`);
  console.log(`CompanyDB : ${SAP_CLIENT}`);
  console.log(`User      : ${SAP_USER}`);
  console.log(`Mode      : ${DRY_RUN ? 'DRY-RUN (aucun PATCH ni resync)' : 'RÉEL'}`);
  console.log('');

  // ─── 1. Inventaire NOVA-PA ─────────────────────────────────────────────────
  console.log('[1/6] Inventaire supplier_cache NOVA-PA…');
  const allCount = await prisma.supplierCache.count();
  const candidates = await prisma.supplierCache.findMany({
    where: {
      federaltaxid: { not: null },
    },
    select: { cardcode: true, cardname: true, federaltaxid: true },
    orderBy: { cardcode: 'asc' },
  });
  const withSource = candidates.filter((c) => (c.federaltaxid ?? '').trim().length > 0);
  const missingSource = await prisma.supplierCache.findMany({
    where: {
      OR: [{ federaltaxid: null }, { federaltaxid: '' }],
    },
    select: { cardcode: true, cardname: true, vatregnum: true },
    orderBy: { cardcode: 'asc' },
  });
  console.log(`      ${allCount} fournisseur(s) en cache.`);
  console.log(`      ${withSource.length} avec federaltaxid non vide (candidats au push).`);
  console.log(`      ${missingSource.length} sans federaltaxid (ignorés).`);
  if (missingSource.length > 0) {
    console.log('      Détail des fournisseurs sans federaltaxid en cache :');
    for (const m of missingSource) {
      const vat = (m.vatregnum ?? '').trim();
      console.log(
        `        ${pad(m.cardcode, 10)} | ${pad(m.cardname, 36)} | vatregnum=${vat || '(vide)'}`,
      );
    }
  }
  console.log('');

  if (withSource.length === 0) {
    console.log('Aucune valeur à pousser. Fin.');
    return;
  }

  // ─── 2. Login SAP ──────────────────────────────────────────────────────────
  const password = await promptPassword(`Mot de passe SAP pour ${SAP_USER}@${SAP_CLIENT} : `);
  if (!password) throw new Error('Mot de passe vide');
  console.log('[2/6] Login SAP…');
  const cookie = await sapLogin(password);
  console.log('      OK\n');

  const plan: PlanEntry[] = [];
  const outcomes: PushOutcome[] = [];

  try {
    // ─── 3. Vérification SAP de chaque candidat ──────────────────────────────
    console.log(`[3/6] Lecture FederalTaxID SAP pour ${withSource.length} BP…`);
    let i = 0;
    for (const c of withSource) {
      i++;
      const novaVat = (c.federaltaxid ?? '').trim();
      try {
        const bp = await getBpFederalTaxId(cookie, c.cardcode);
        if ('notFound' in bp) {
          plan.push({
            cardcode: c.cardcode,
            cardname: c.cardname,
            novaFederalTaxId: novaVat,
            sapFederalTaxId: null,
            bucket: 'D_sap_not_found',
          });
        } else if (bp.FederalTaxID && bp.FederalTaxID.length > 0) {
          plan.push({
            cardcode: c.cardcode,
            cardname: bp.CardName || c.cardname,
            novaFederalTaxId: novaVat,
            sapFederalTaxId: bp.FederalTaxID,
            bucket: 'A_already_set',
          });
        } else {
          plan.push({
            cardcode: c.cardcode,
            cardname: bp.CardName || c.cardname,
            novaFederalTaxId: novaVat,
            sapFederalTaxId: null,
            bucket: 'B_to_push',
          });
        }
      } catch (err) {
        plan.push({
          cardcode: c.cardcode,
          cardname: c.cardname,
          novaFederalTaxId: novaVat,
          sapFederalTaxId: null,
          bucket: 'D_sap_not_found',
        });
        console.log(
          `      ${c.cardcode} → erreur GET : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (i % 25 === 0 || i === withSource.length) {
        process.stdout.write(`\r      Lus : ${i}/${withSource.length}`);
      }
    }
    process.stdout.write('\n');

    const toPush = plan.filter((p) => p.bucket === 'B_to_push');
    const alreadySet = plan.filter((p) => p.bucket === 'A_already_set');
    const notFound = plan.filter((p) => p.bucket === 'D_sap_not_found');

    console.log(`      À pousser (SAP vide)  : ${toPush.length}`);
    console.log(`      Déjà renseignés       : ${alreadySet.length}`);
    console.log(`      BP introuvables/erreur: ${notFound.length}\n`);

    // ─── 4. PATCH des BP ─────────────────────────────────────────────────────
    if (toPush.length === 0) {
      console.log('[4/6] Aucun PATCH à effectuer.\n');
    } else if (DRY_RUN) {
      console.log(`[4/6] DRY-RUN : ${toPush.length} PATCH non exécuté(s).\n`);
    } else {
      console.log(`[4/6] PATCH BusinessPartners (${toPush.length})…`);
      let j = 0;
      for (const p of toPush) {
        j++;
        const r = await patchBpFederalTaxId(cookie, p.cardcode, p.novaFederalTaxId);
        outcomes.push({
          cardcode: p.cardcode,
          cardname: p.cardname,
          vat: p.novaFederalTaxId,
          http: r.http,
          ok: r.ok,
          detail: r.detail,
        });
        if (!r.ok) {
          console.log(
            `\n      ${p.cardcode} → HTTP ${r.http} ERREUR${
              r.detail ? ' : ' + r.detail.replace(/\s+/g, ' ').slice(0, 200) : ''
            }`,
          );
        }
        if (j % 10 === 0 || j === toPush.length) {
          process.stdout.write(`\r      Patché : ${j}/${toPush.length}`);
        }
      }
      process.stdout.write('\n\n');
    }

    // ─── 5. Resync supplier_cache ────────────────────────────────────────────
    let synced = 0;
    if (DRY_RUN) {
      console.log('[5/6] DRY-RUN : resync supplier_cache ignorée.\n');
    } else {
      console.log('[5/6] Resync supplier_cache depuis SAP…');
      synced = await resyncSupplierCache(cookie);
      console.log(`      ${synced} fournisseur(s) upsertis en base NOVA-PA.\n`);
    }
  } finally {
    console.log('[6/6] Logout SAP…');
    await sapLogout(cookie);
    console.log('      OK\n');
  }

  // ─── Rapport ──────────────────────────────────────────────────────────────
  const toPush = plan.filter((p) => p.bucket === 'B_to_push');
  const alreadySet = plan.filter((p) => p.bucket === 'A_already_set');
  const notFound = plan.filter((p) => p.bucket === 'D_sap_not_found');

  // Tableau détaillé : on imprime uniquement les lignes "B" (tentatives de push)
  if (toPush.length > 0) {
    console.log('=== Détail des push (catégorie B) ===');
    const header =
      pad('CardCode', 10) +
      ' | ' +
      pad('Nom fournisseur', 32) +
      ' | ' +
      pad('FederalTaxID', 20) +
      ' | Résultat';
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const p of toPush) {
      const out = outcomes.find((o) => o.cardcode === p.cardcode);
      const result = DRY_RUN
        ? '(dry-run)'
        : out
          ? `${out.http} ${out.ok ? 'OK' : '✗'}`
          : '— (pas tenté)';
      console.log(
        pad(p.cardcode, 10) +
          ' | ' +
          pad(p.cardname, 32) +
          ' | ' +
          pad(p.novaFederalTaxId, 20) +
          ' | ' +
          result,
      );
    }
    console.log('');
  }

  if (alreadySet.length > 0 && alreadySet.length <= 20) {
    console.log('=== Déjà renseignés dans SAP (ignorés) ===');
    for (const p of alreadySet) {
      console.log(
        `  ${pad(p.cardcode, 10)} | ${pad(p.cardname, 32)} | SAP=${p.sapFederalTaxId} / NOVA=${p.novaFederalTaxId}`,
      );
    }
    console.log('');
  } else if (alreadySet.length > 20) {
    console.log(`=== Déjà renseignés dans SAP : ${alreadySet.length} (liste tronquée) ===\n`);
  }

  if (notFound.length > 0) {
    console.log(`=== BP introuvables ou erreur GET : ${notFound.length} ===`);
    for (const p of notFound.slice(0, 20)) {
      console.log(`  ${p.cardcode} | ${p.cardname}`);
    }
    if (notFound.length > 20) console.log(`  … et ${notFound.length - 20} autres`);
    console.log('');
  }

  const okCount = outcomes.filter((o) => o.ok).length;
  const errCount = outcomes.filter((o) => !o.ok).length;
  const noSource = (await prisma.supplierCache.count()) - withSource.length;

  console.log('=== RÉSUMÉ ===');
  console.log(
    `Fournisseurs mis à jour      : ${DRY_RUN ? `${toPush.length} (planifiés)` : okCount}`,
  );
  console.log(`Déjà renseignés (ignorés)    : ${alreadySet.length}`);
  console.log(`Sans TVA dispo (ignorés)     : ${noSource}`);
  console.log(`BP introuvables / GET KO     : ${notFound.length}`);
  console.log(`Erreurs PATCH                : ${DRY_RUN ? '(dry-run)' : errCount}`);
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
