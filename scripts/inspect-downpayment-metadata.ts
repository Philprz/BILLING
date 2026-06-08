/**
 * LECTURE SEULE — confirme la structure du tirage d'acompte (DownPaymentsToDraw)
 * contre le SAP B1 Service Layer LIVE. Login + GET uniquement. Aucune écriture.
 *
 * Usage : tsx scripts/inspect-downpayment-metadata.ts
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
  if (!res.ok) {
    throw new Error(`Login échoué : HTTP ${res.status}`);
  }
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

function printMatches(label: string, xml: string, re: RegExp) {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  console.log(`\n=== ${label} ===`);
  while ((m = re.exec(xml)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      console.log(m[0]);
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

  // 1) $metadata — chercher tout ce qui touche au DownPayment ToDraw
  const meta = await getText(cookie, '/$metadata');
  console.log(`\n$metadata : HTTP ${meta.status}, ${meta.body.length} octets`);

  // ComplexType / EntityType portant "DownPayment...ToDraw"
  printMatches(
    'ComplexType/EntityType *DownPayment*ToDraw*',
    meta.body,
    /<(?:ComplexType|EntityType)\b[^>]*Name="[^"]*DownPayment[^"]*ToDraw[^"]*"[^>]*>/gi,
  );

  // Propriétés déclarées DANS ces types (on isole le bloc puis on liste les <Property>)
  const typeBlocks = meta.body.match(
    /<(ComplexType|EntityType)\b[^>]*Name="[^"]*DownPayment[^"]*ToDraw[^"]*"[\s\S]*?<\/\1>/gi,
  );
  console.log('\n=== Propriétés des types *DownPayment*ToDraw* ===');
  if (typeBlocks) {
    for (const block of typeBlocks) {
      const name = block.match(/Name="([^"]+)"/)?.[1];
      console.log(`\n-- ${name} --`);
      const props = block.match(/<Property\b[^>]*\/?>/gi) ?? [];
      for (const p of props) {
        const pn = p.match(/Name="([^"]+)"/)?.[1];
        const pt = p.match(/Type="([^"]+)"/)?.[1];
        console.log(`   ${pn} : ${pt}`);
      }
    }
  } else {
    console.log('(aucun bloc trouvé)');
  }

  // NavigationProperty / Property nommée DownPayment...ToDraw (sur Document)
  printMatches(
    'Property/NavigationProperty *DownPayment*ToDraw* (collections sur Document)',
    meta.body,
    /<(?:Property|NavigationProperty)\b[^>]*Name="[^"]*DownPayment[^"]*ToDraw[^"]*"[^>]*\/?>/gi,
  );

  // 2) Exemples de documents (lecture seule) — structure réellement persistée
  const adp = await getText(
    cookie,
    '/APDownPayments?$select=DocEntry,DocNum,DocType,DocTotal&$orderby=DocEntry desc&$top=3',
  );
  console.log(`\n=== APDownPayments (3 derniers) — HTTP ${adp.status} ===`);
  try {
    const rows = (JSON.parse(adp.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows)
      console.log(
        `   DocEntry=${r.DocEntry} DocNum=${r.DocNum} DocType=${r.DocType} DocTotal=${r.DocTotal}`,
      );
    if (rows.length === 0) console.log('   (aucun acompte fournisseur dans cette base)');
  } catch {
    console.log(adp.body.slice(0, 300));
  }

  // PurchaseInvoices ayant tiré un acompte : on lit les plus récentes et on inspecte
  // la collection DownPaymentsToDraw réellement renvoyée par SAP.
  const pi = await getText(
    cookie,
    '/PurchaseInvoices?$select=DocEntry,DocNum,DownPaymentsToDraw&$orderby=DocEntry desc&$top=25',
  );
  console.log(`\n=== PurchaseInvoices avec DownPaymentsToDraw non vide — HTTP ${pi.status} ===`);
  try {
    const rows = (JSON.parse(pi.body).value ?? []) as Array<Record<string, unknown>>;
    let found = 0;
    for (const r of rows) {
      const draws = (r.DownPaymentsToDraw as unknown[]) ?? [];
      if (Array.isArray(draws) && draws.length > 0) {
        found++;
        console.log(`   DocEntry=${r.DocEntry} DocNum=${r.DocNum} →`, JSON.stringify(draws));
      }
    }
    if (found === 0)
      console.log('   (aucune facture d’achat avec tirage d’acompte dans les 25 dernières)');
  } catch {
    console.log(pi.body.slice(0, 300));
  }

  console.log('\n--- FIN (lecture seule, aucun POST/PATCH/DELETE de document) ---');
}

main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
