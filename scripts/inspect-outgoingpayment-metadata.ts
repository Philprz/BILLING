/**
 * LECTURE SEULE — confirme la structure du payload `OutgoingPayments` (paiement
 * fournisseur sortant + lettrage) contre le SAP B1 Service Layer LIVE.
 * Login + GET uniquement. AUCUNE écriture (le POST paiement = manuel encadré).
 * Ne logue jamais le mot de passe.
 *
 * Usage : tsx scripts/inspect-outgoingpayment-metadata.ts
 *
 * Objectifs (niveau payé S/B 2, partie A) :
 *  1. Champs requis d'un paiement fournisseur sur l'EntityType `Payment`
 *     (DocType / DocObjectCode, CardCode, moyen : TransferAccount/TransferSum,
 *     CheckAccount, CashAccount, BankCode…).
 *  2. La collection de lettrage `PaymentInvoices`
 *     ({ DocEntry, InvoiceType, SumApplied }) qui solde le poste.
 *  3. L'enum `BoRcptInvTypes` (valeurs InvoiceType — it_PurchaseInvoice…).
 *  4. Un OutgoingPayments réel s'il en existe (structure persistée).
 */
import 'dotenv/config';

if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const BASE = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const COMPANY = process.env.SAP_CLIENT ?? 'SBODemoFR';
const USER = process.env.SAP_USER ?? 'manager';
const PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: COMPANY, UserName: USER, Password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login échoué : HTTP ${res.status}`);
  const setCookie =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : (res.headers.get('set-cookie') ?? '');
  const b1 = setCookie.match(/B1SESSION=([^;,\s]+)/)?.[1];
  if (!b1) throw new Error('B1SESSION absent dans la réponse Login');
  return `B1SESSION=${b1}`;
}

async function getText(cookie: string, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.text() };
}

function printEnum(label: string, xml: string, enumName: string) {
  console.log(`\n=== EnumType ${enumName} (${label}) ===`);
  const block = xml.match(
    new RegExp(`<EnumType\\b[^>]*Name="${enumName}"[\\s\\S]*?</EnumType>`, 'i'),
  );
  if (!block) {
    console.log('(type introuvable)');
    return;
  }
  for (const m of block[0].match(/<Member\b[^>]*Name="([^"]+)"[^>]*\/?>/gi) ?? []) {
    const name = m.match(/Name="([^"]+)"/)?.[1];
    const val = m.match(/Value="([^"]+)"/)?.[1];
    console.log(`   ${name}${val !== undefined ? ` = ${val}` : ''}`);
  }
}

function printTypeProps(label: string, xml: string, typeName: string, filter: RegExp) {
  console.log(`\n=== ${typeName} — Property ${label} ===`);
  const block = xml.match(
    new RegExp(`<EntityType\\b[^>]*Name="${typeName}"[\\s\\S]*?</EntityType>`, 'i'),
  );
  if (!block) {
    console.log('(type introuvable)');
    return;
  }
  const seen = new Set<string>();
  for (const m of block[0].match(/<Property\b[^>]*\/?>/gi) ?? []) {
    const name = m.match(/Name="([^"]+)"/)?.[1] ?? '';
    if (!filter.test(name) || seen.has(name)) continue;
    seen.add(name);
    console.log(`   ${name} : ${m.match(/Type="([^"]+)"/)?.[1]}`);
  }
  for (const m of block[0].match(/<NavigationProperty\b[^>]*\/?>/gi) ?? []) {
    const name = m.match(/Name="([^"]+)"/)?.[1] ?? '';
    if (!filter.test(name) || seen.has(name)) continue;
    seen.add(name);
    console.log(`   [nav] ${name} : ${m.match(/Type="([^"]+)"/)?.[1]}`);
  }
}

async function main() {
  console.log(`BASE     : ${BASE}`);
  console.log(`CompanyDB: ${COMPANY}`);
  console.log(`User     : ${USER}`);
  if (!PASSWORD) throw new Error('SAP_CLIENT_PASSWORD non défini');

  const cookie = await login();
  console.log('Login OK (B1SESSION obtenu).');

  const meta = await getText(cookie, '/$metadata');
  console.log(`$metadata : HTTP ${meta.status}, ${meta.body.length} octets`);

  // 1) Champs paiement / moyen / lettrage sur Payment
  printTypeProps(
    '*paiement/moyen*',
    meta.body,
    'Payment',
    /^(DocType|DocObjectCode|CardCode|DocCurrency|DocRate|DocDate|TransferAccount|TransferSum|TransferDate|TransferReference|CashAccount|CashSum|CheckAccount|BankCode|PaymentMeans|DocEntry|DocNum)$/,
  );
  // 1bis) La collection de lettrage PaymentInvoices
  printTypeProps('*lettrage*', meta.body, 'Payment', /Invoice/);
  // 2) Ligne de lettrage
  printTypeProps('*ligne lettrage*', meta.body, 'PaymentInvoice', /.*/);
  // 3) Enums utiles
  printEnum('type document payé', meta.body, 'BoRcptInvTypes');
  printEnum('objet du document', meta.body, 'BoPaymentsObjectType');

  // 4) Un OutgoingPayments réel (structure persistée), si présent
  const list = await getText(
    cookie,
    '/OutgoingPayments?$select=DocEntry,DocNum,CardCode,DocCurrency,DocType,TransferSum,CashSum,CheckSum&$orderby=DocEntry desc&$top=5',
  );
  console.log(`\n=== OutgoingPayments (5 derniers) — HTTP ${list.status} ===`);
  try {
    const rows = (JSON.parse(list.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) console.log('  ', JSON.stringify(r));
    if (rows.length === 0) {
      console.log('   (0 paiement sortant — structure persistée non inspectable sans écriture)');
    } else {
      const det = await getText(cookie, `/OutgoingPayments(${rows[0].DocEntry})`);
      const o = JSON.parse(det.body) as Record<string, unknown>;
      console.log(`   -- OutgoingPayments(${rows[0].DocEntry}) — champs moyen/lettrage --`);
      for (const k of Object.keys(o).filter((k) =>
        /CardCode|DocType|DocObjectCode|Transfer|Cash|Check|Bank|Sum|PaymentInvoices|DocCurrency/i.test(
          k,
        ),
      ))
        console.log(`      ${k} = ${JSON.stringify(o[k])}`);
    }
  } catch {
    console.log(list.body.slice(0, 600));
  }

  console.log('\n--- FIN (lecture seule, aucun POST/PATCH/DELETE) ---');
}

main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
