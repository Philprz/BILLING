/** LECTURE SEULE — détails ComplexType PaymentInvoice + enums BoRcptTypes/BoStatus
 * + champs paiement réels d'un fournisseur. Login + GET. Aucune écriture. */
import 'dotenv/config';
if (process.env.SAP_IGNORE_SSL === 'true') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
  if (!res.ok) throw new Error(`Login HTTP ${res.status}`);
  const sc =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : (res.headers.get('set-cookie') ?? '');
  return `B1SESSION=${sc.match(/B1SESSION=([^;,\s]+)/)?.[1]}`;
}
async function get(cookie: string, p: string) {
  const res = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.text() };
}
function complexType(xml: string, name: string) {
  console.log(`\n=== ComplexType ${name} ===`);
  const b = xml.match(
    new RegExp(`<ComplexType\\b[^>]*Name="${name}"[\\s\\S]*?</ComplexType>`, 'i'),
  );
  if (!b) return console.log('(introuvable)');
  for (const m of b[0].match(/<Property\b[^>]*\/?>/gi) ?? [])
    console.log(`   ${m.match(/Name="([^"]+)"/)?.[1]} : ${m.match(/Type="([^"]+)"/)?.[1]}`);
}
function enumType(xml: string, name: string) {
  console.log(`\n=== EnumType ${name} ===`);
  const b = xml.match(new RegExp(`<EnumType\\b[^>]*Name="${name}"[\\s\\S]*?</EnumType>`, 'i'));
  if (!b) return console.log('(introuvable)');
  for (const m of b[0].match(/<Member\b[^>]*\/?>/gi) ?? [])
    console.log(`   ${m.match(/Name="([^"]+)"/)?.[1]}`);
}
async function main() {
  if (!PASSWORD) throw new Error('SAP_CLIENT_PASSWORD non défini');
  const cookie = await login();
  const meta = await get(cookie, '/$metadata');
  console.log(`$metadata HTTP ${meta.status}`);
  complexType(meta.body, 'PaymentInvoice');
  complexType(meta.body, 'BPPaymentMethod');
  complexType(meta.body, 'BPBankAccount');
  enumType(meta.body, 'BoRcptTypes');
  enumType(meta.body, 'BoStatus');

  const bp = await get(
    cookie,
    "/BusinessPartners?$select=CardCode,CardName,PeymentMethodCode,DefaultBankCode,HouseBank,HouseBankAccount,HouseBankIBAN&$filter=CardType eq 'cSupplier'&$orderby=CardCode&$top=6",
  );
  console.log(`\n=== BusinessPartners fournisseurs — moyen réel — HTTP ${bp.status} ===`);
  try {
    for (const r of (JSON.parse(bp.body).value ?? []) as Record<string, unknown>[])
      console.log('  ', JSON.stringify(r));
  } catch {
    console.log(bp.body.slice(0, 600));
  }
  console.log('\n--- FIN (lecture seule) ---');
}
main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
