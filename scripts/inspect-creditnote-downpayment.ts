/**
 * LECTURE SEULE — confirme le mécanisme SAP B1 de contre-passation (partielle ou
 * totale) d'un A/P Down Payment via un avoir d'achat (503 → 386).
 * Login + GET uniquement. Aucune écriture (POST/PATCH/DELETE de document).
 * Ne logue jamais le mot de passe.
 *
 * Usage : tsx scripts/inspect-creditnote-downpayment.ts
 *
 * Questions tranchées :
 *  1. Un PurchaseCreditNotes peut-il porter une collection DownPaymentsToDraw
 *     (tirage d'acompte sur l'avoir) ? → champs du type *DownPaymentToDraw*.
 *  2. Sinon, les lignes d'avoir peuvent-elles pointer un down payment via
 *     BaseType/BaseEntry/BaseLine (BoObjectTypes admissibles) ?
 *  3. Structure d'un APDownPayments réel (DocType, OpenAmount, champs d'acompte).
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

function printMatches(label: string, xml: string, re: RegExp, max = 60) {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  console.log(`\n=== ${label} ===`);
  while ((m = re.exec(xml)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      console.log(m[0]);
      if (seen.size >= max) break;
    }
  }
  if (seen.size === 0) console.log('(aucune occurrence)');
}

async function main() {
  console.log(`BASE     : ${BASE}`);
  console.log(`CompanyDB: ${COMPANY}`);
  console.log(`User     : ${USER}`);
  if (!PASSWORD) throw new Error('SAP_CLIENT_PASSWORD non défini');

  const cookie = await login();
  console.log('Login OK (B1SESSION obtenu).');

  const meta = await getText(cookie, '/$metadata');
  console.log(`\n$metadata : HTTP ${meta.status}, ${meta.body.length} octets`);

  // 1) Type(s) *DownPayment*ToDraw* + leurs propriétés (DocEntry / AmountToDraw / Base*…)
  const typeBlocks = meta.body.match(
    /<(ComplexType|EntityType)\b[^>]*Name="[^"]*DownPayment[^"]*ToDraw[^"]*"[\s\S]*?<\/\1>/gi,
  );
  console.log('\n=== Propriétés des types *DownPayment*ToDraw* ===');
  if (typeBlocks) {
    for (const block of typeBlocks) {
      const name = block.match(/Name="([^"]+)"/)?.[1];
      console.log(`\n-- ${name} --`);
      for (const p of block.match(/<Property\b[^>]*\/?>/gi) ?? []) {
        console.log(`   ${p.match(/Name="([^"]+)"/)?.[1]} : ${p.match(/Type="([^"]+)"/)?.[1]}`);
      }
    }
  } else console.log('(aucun bloc trouvé)');

  // 2) La collection DownPaymentsToDraw est-elle exposée sur Document (donc sur les avoirs) ?
  printMatches(
    'Property/NavigationProperty *DownPaymentsToDraw* (sur Document)',
    meta.body,
    /<(?:Property|NavigationProperty)\b[^>]*Name="[^"]*DownPayment[^"]*ToDraw[^"]*"[^>]*\/?>/gi,
  );

  // 3) Lignes : BaseType / BaseEntry / BaseLine (adossement d'une ligne à un autre doc)
  printMatches(
    'DocumentLine — BaseType / BaseEntry / BaseLine / BaseRef',
    meta.body,
    /<Property\b[^>]*Name="(?:BaseType|BaseEntry|BaseLine|BaseRef|BaseDocType)"[^>]*\/?>/gi,
  );

  // 4) Enum des types d'objets de base (BoObjectTypes) — pour voir le code du down payment
  printMatches(
    'EnumType BoObjectTypes — membres *DownPayment* / *CreditNote*',
    meta.body,
    /<Member\b[^>]*Name="[^"]*(?:DownPayment|CreditNote|Invoice)[^"]*"[^>]*\/?>/gi,
  );

  // 5) Champs d'acompte sur Document (DownPaymentType, DownPaymentStatus, OpenAmount…)
  printMatches(
    'Document — champs DownPayment* / *Open*',
    meta.body,
    /<Property\b[^>]*Name="(?:DownPayment\w*|OpenAmount\w*|PaidToDate\w*|DownPaymentTrgtAmount)"[^>]*\/?>/gi,
  );

  // 6) Nom RÉEL de l'EntitySet des acomptes fournisseur dans cette version SL.
  //    (Le code historique utilise "APDownPayments" — à confronter ici.)
  const sets = [...meta.body.matchAll(/<EntitySet\b[^>]*Name="([^"]+)"/gi)].map((m) => m[1]);
  console.log('\n=== EntitySet *DownPayment* / *CreditNote* (noms réels) ===');
  for (const s of sets) if (/DownPayment|CreditNote|PurchaseInvoice/i.test(s)) console.log('  ', s);
  for (const cand of ['PurchaseDownPayments', 'APDownPayments', 'PurchaseCreditNotes']) {
    const r = await getText(cookie, `/${cand}?$select=DocEntry&$top=1`);
    console.log(`   GET /${cand} → HTTP ${r.status}`);
  }

  // 7) Exemples réels — PurchaseDownPayments (entité confirmée en 6)
  const adp = await getText(
    cookie,
    '/PurchaseDownPayments?$select=DocEntry,DocNum,DocType,DocTotal,DocCurrency&$orderby=DocEntry desc&$top=5',
  );
  console.log(`\n=== PurchaseDownPayments (5 derniers) — HTTP ${adp.status} ===`);
  try {
    const rows = (JSON.parse(adp.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) console.log('  ', JSON.stringify(r));
    if (rows.length === 0)
      console.log('   (0 acompte fournisseur → tirage non testable sans écriture)');
  } catch {
    console.log(adp.body.slice(0, 400));
  }

  // 8) Un PurchaseCreditNotes existant — porte-t-il DownPaymentsToDraw / lignes Base* ?
  const cn = await getText(
    cookie,
    '/PurchaseCreditNotes?$select=DocEntry,DocNum,DownPaymentsToDraw&$orderby=DocEntry desc&$top=10',
  );
  console.log(
    `\n=== PurchaseCreditNotes (10 derniers) — DownPaymentsToDraw non vide ? — HTTP ${cn.status} ===`,
  );
  try {
    const rows = (JSON.parse(cn.body).value ?? []) as Array<Record<string, unknown>>;
    let found = 0;
    for (const r of rows) {
      const draws = (r.DownPaymentsToDraw as unknown[]) ?? [];
      if (Array.isArray(draws) && draws.length > 0) {
        found++;
        console.log(`   DocEntry=${r.DocEntry} DocNum=${r.DocNum} →`, JSON.stringify(draws));
      }
    }
    if (found === 0) console.log('   (aucun avoir avec tirage d’acompte dans les 10 derniers)');
  } catch {
    console.log(cn.body.slice(0, 400));
  }

  console.log('\n--- FIN (lecture seule, aucun POST/PATCH/DELETE de document) ---');
}

main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
