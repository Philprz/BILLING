/**
 * LECTURE SEULE — confirme contre le SAP B1 Service Layer LIVE :
 *   (A) le moyen de paiement / banque par défaut d'un BusinessPartner fournisseur
 *       (PaymentMethodCode, HouseBank, BPBankAccounts…) qui doit piloter le paiement ;
 *   (B) le champ d'état de règlement d'une PurchaseInvoices (DocumentStatus,
 *       PaidToDate… ; l'OpenAmount est calculé côté SL) ;
 *   (C) l'existence de l'UDF `U_NOVA_Statut` sur OPCH (sinon à créer).
 * Login + GET uniquement. AUCUNE écriture. Ne logue jamais le mot de passe.
 *
 * Usage : tsx scripts/inspect-bp-paymentmethod-novastatut.ts
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
  for (const m of block[0].match(/<(Property|NavigationProperty)\b[^>]*\/?>/gi) ?? []) {
    const name = m.match(/Name="([^"]+)"/)?.[1] ?? '';
    if (!filter.test(name) || seen.has(name)) continue;
    seen.add(name);
    console.log(`   ${name} : ${m.match(/Type="([^"]+)"/)?.[1]}`);
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

  // (A) Moyen de paiement / banque sur BusinessPartner
  printTypeProps(
    '*moyen de paiement / banque*',
    meta.body,
    'BusinessPartner',
    /(PaymentMethod|HouseBank|BankCode|BankCountry|BICSwift|DefaultBankCode|PeymentMethod|PayTo|BPBankAccount)/i,
  );
  // (B) État de règlement sur Document (factures)
  printTypeProps(
    '*état de règlement*',
    meta.body,
    'Document',
    /^(DocumentStatus|DocStatus|PaidToDate|PaidSum|DocTotal|OpenAmount|DocTotalFc|PaidToDateFC)$/,
  );

  // (A) Un fournisseur réel avec ses champs de paiement
  const bp = await getText(
    cookie,
    "/BusinessPartners?$select=CardCode,CardName,PaymentMethodCode,HouseBank,HouseBankCountry,HouseBankAccount,DefaultBankCode&$filter=CardType eq 'cSupplier'&$orderby=CardCode&$top=5",
  );
  console.log(`\n=== BusinessPartners fournisseurs (5) — HTTP ${bp.status} ===`);
  try {
    const rows = (JSON.parse(bp.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) console.log('  ', JSON.stringify(r));
    if (rows.length > 0) {
      const det = await getText(
        cookie,
        `/BusinessPartners('${String(rows[0].CardCode).replace(/'/g, "''")}')?$select=CardCode,PaymentMethodCode,HouseBank,HouseBankAccount,BPBankAccounts`,
      );
      const o = JSON.parse(det.body) as Record<string, unknown>;
      console.log(`   -- BusinessPartner(${rows[0].CardCode}) — moyen/banque --`);
      for (const k of Object.keys(o).filter((k) =>
        /PaymentMethod|HouseBank|BPBankAccounts|DefaultBankCode/i.test(k),
      ))
        console.log(`      ${k} = ${JSON.stringify(o[k])}`);
    }
  } catch {
    console.log(bp.body.slice(0, 600));
  }

  // (B) Une PurchaseInvoices avec son état de règlement (poste ouvert)
  const pi = await getText(
    cookie,
    '/PurchaseInvoices?$select=DocEntry,DocNum,CardCode,DocTotal,PaidToDate,DocumentStatus&$orderby=DocEntry desc&$top=5',
  );
  console.log(`\n=== PurchaseInvoices (5 dernières) — état règlement — HTTP ${pi.status} ===`);
  try {
    const rows = (JSON.parse(pi.body).value ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) console.log('  ', JSON.stringify(r));
  } catch {
    console.log(pi.body.slice(0, 600));
  }

  // (C) UDF U_NOVA_Statut sur OPCH déjà présente ?
  const udf = await getText(
    cookie,
    "/UserFieldsMD?$filter=TableName eq 'OPCH' and Name eq 'NOVA_Statut'&$select=TableName,Name,Type,Size,FieldID",
  );
  console.log(`\n=== UserFieldsMD OPCH/NOVA_Statut — HTTP ${udf.status} ===`);
  try {
    const rows = (JSON.parse(udf.body).value ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      console.log('   (UDF U_NOVA_Statut ABSENTE sur OPCH → à créer via createSapUdfNovaStatut)');
    } else {
      for (const r of rows) console.log('  ', JSON.stringify(r));
    }
  } catch {
    console.log(udf.body.slice(0, 600));
  }

  console.log('\n--- FIN (lecture seule, aucun POST/PATCH/DELETE) ---');
}

main().catch((e) => {
  console.error('ERREUR:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
