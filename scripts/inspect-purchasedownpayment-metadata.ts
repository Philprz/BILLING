/**
 * LECTURE SEULE — confirme la structure du payload `PurchaseDownPayments` (386,
 * facture d'acompte fournisseur) contre le SAP B1 Service Layer LIVE.
 * Login + GET uniquement. Aucune écriture. Ne logue jamais le mot de passe.
 *
 * Usage : tsx scripts/inspect-purchasedownpayment-metadata.ts
 *
 * Objectifs :
 *  1. Valeurs admissibles de `DownPaymentTypeEnum` (dptInvoice vs dptOrder…).
 *  2. Champs spécifiques acompte sur l'entité `Document` (DownPaymentType,
 *     DownPaymentAmount/Percentage, DownPaymentStatus…).
 *  3. Valeurs de `BoDocumentTypes` (DocType : Service vs Items).
 *  4. Un PurchaseDownPayments réel s'il en existe (structure persistée).
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

async function main() {
  console.log(`BASE     : ${BASE}`);
  console.log(`CompanyDB: ${COMPANY}`);
  console.log(`User     : ${USER}`);
  if (!PASSWORD) throw new Error('SAP_CLIENT_PASSWORD non défini');

  const cookie = await login();
  console.log('Login OK (B1SESSION obtenu).');

  const meta = await getText(cookie, '/$metadata');
  console.log(`$metadata : HTTP ${meta.status}, ${meta.body.length} octets`);

  // 1) DownPaymentType admissibles
  printEnum('type de down payment', meta.body, 'DownPaymentTypeEnum');
  // 3) DocType (Service vs Items)
  printEnum('DocType', meta.body, 'BoDocumentTypes');

  // 2) Champs *DownPayment* sur Document (déjà partiellement connus) — on liste
  //    pour figer ce qui distingue un acompte d'une facture.
  console.log('\n=== Document — Property *DownPayment* (champs acompte) ===');
  const seen = new Set<string>();
  for (const m of meta.body.match(/<Property\b[^>]*Name="(DownPayment\w*|DpmRef\w*)"[^>]*\/?>/gi) ??
    []) {
    if (!seen.has(m)) {
      seen.add(m);
      console.log(`   ${m.match(/Name="([^"]+)"/)?.[1]} : ${m.match(/Type="([^"]+)"/)?.[1]}`);
    }
  }

  // 4) Un PurchaseDownPayments réel (structure persistée), si présent
  const list = await getText(
    cookie,
    '/PurchaseDownPayments?$select=DocEntry,DocNum,DocType,DocTotal,DocCurrency&$orderby=DocEntry desc&$top=3',
  );
  console.log(`\n=== PurchaseDownPayments (3 derniers) — HTTP ${list.status} ===`);
  try {
    const rows = (JSON.parse(list.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) console.log('  ', JSON.stringify(r));
    if (rows.length === 0) {
      console.log('   (0 acompte fournisseur — structure persistée non inspectable sans écriture)');
    } else {
      const det = await getText(cookie, `/PurchaseDownPayments(${rows[0].DocEntry})`);
      const o = JSON.parse(det.body) as Record<string, unknown>;
      console.log(`   -- PurchaseDownPayments(${rows[0].DocEntry}) — champs acompte/type --`);
      for (const k of Object.keys(o).filter((k) =>
        /DownPayment|DocType|DocTotal|VatSum|Open|Paid/i.test(k),
      ))
        console.log(`      ${k} = ${JSON.stringify(o[k])}`);
      const l0 = (o.DocumentLines as Array<Record<string, unknown>> | undefined)?.[0];
      if (l0) {
        console.log('   -- DocumentLines[0] (clés) --');
        console.log('     ', Object.keys(l0).join(', '));
      }
    }
  } catch {
    console.log(list.body.slice(0, 400));
  }

  console.log('\n--- FIN (lecture seule, aucun POST/PATCH/DELETE de document) ---');
}

main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
