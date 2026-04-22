/**
 * Synchronise la table supplier_cache depuis SAP B1 Service Layer.
 * Récupère tous les fournisseurs (CardType = cSupplier) avec CardCode,
 * CardName, FederalTaxID, VatRegNum via l'OData SAP.
 * Upsert idempotent — relancer ne crée pas de doublons.
 * Usage : npm run sync:suppliers
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Bypass certificat auto-signé SAP (dev uniquement)
if (process.env.SAP_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const prisma = new PrismaClient();

const SAP_BASE_URL = (process.env.SAP_REST_BASE_URL ?? '').replace(/\/$/, '');
const SAP_CLIENT   = process.env.SAP_CLIENT ?? '';
const SAP_USER     = process.env.SAP_USER ?? '';
const SAP_PASSWORD = process.env.SAP_CLIENT_PASSWORD ?? '';
const PAGE_SIZE    = 100;

interface SapSupplier {
  CardCode:               string;
  CardName:               string;
  FederalTaxID:           string;
  VATRegistrationNumber:  string;
}

// ─── Auth SAP ────────────────────────────────────────────────────────────────

async function sapLogin(): Promise<string> {
  const res = await fetch(`${SAP_BASE_URL}/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_CLIENT, UserName: SAP_USER, Password: SAP_PASSWORD }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Connexion SAP échouée (${res.status}) : ${body}`);
  }

  const cookie = res.headers.get('set-cookie') ?? '';
  const match  = cookie.match(/B1SESSION=([^;,\s]+)/);
  if (!match) throw new Error('B1SESSION absent de la réponse SAP');
  return match[1];
}

async function sapLogout(session: string): Promise<void> {
  await fetch(`${SAP_BASE_URL}/Logout`, {
    method: 'POST',
    headers: { Cookie: `B1SESSION=${session}` },
  }).catch(() => { /* best-effort */ });
}

// ─── Récupération des fournisseurs ───────────────────────────────────────────

async function fetchSupplierPage(session: string, skip: number): Promise<SapSupplier[]> {
  const params = new URLSearchParams({
    '$filter': "CardType eq 'cSupplier'",
    '$select': 'CardCode,CardName,FederalTaxID,VATRegistrationNumber',
    '$top':    String(PAGE_SIZE),
    '$skip':   String(skip),
    '$orderby':'CardCode',
  });

  const res = await fetch(`${SAP_BASE_URL}/BusinessPartners?${params}`, {
    headers: { Cookie: `B1SESSION=${session}`, Prefer: 'odata.maxpagesize=100' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erreur SAP BusinessPartners (${res.status}) : ${body.slice(0, 200)}`);
  }

  const json = await res.json() as { value?: SapSupplier[] };
  return json.value ?? [];
}

async function fetchAllSuppliers(session: string): Promise<SapSupplier[]> {
  const all: SapSupplier[] = [];
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await fetchSupplierPage(session, skip);
    all.push(...page);
    process.stdout.write(`\r  Récupérés : ${all.length} fournisseurs…`);

    hasMore = page.length === PAGE_SIZE;
    if (hasMore) {
      skip += PAGE_SIZE;
    }
  }

  process.stdout.write('\n');
  return all;
}

// ─── Upsert en base ──────────────────────────────────────────────────────────

async function upsertSuppliers(suppliers: SapSupplier[]): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const now   = new Date();

  for (const s of suppliers) {
    const data = {
      cardname:     s.CardName,
      federaltaxid: s.FederalTaxID?.trim()            || null,
      vatregnum:    s.VATRegistrationNumber?.trim()   || null,
      syncAt:       now,
    };

    const existing = await prisma.supplierCache.findUnique({ where: { cardcode: s.CardCode } });

    if (existing) {
      await prisma.supplierCache.update({ where: { cardcode: s.CardCode }, data });
      updated++;
    } else {
      await prisma.supplierCache.create({ data: { cardcode: s.CardCode, ...data } });
      created++;
    }
  }

  return { created, updated };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SAP_BASE_URL || !SAP_CLIENT || !SAP_USER || !SAP_PASSWORD) {
    throw new Error('Variables SAP manquantes dans .env (SAP_REST_BASE_URL, SAP_CLIENT, SAP_USER, SAP_CLIENT_PASSWORD)');
  }

  console.log(`[SyncSuppliers] Connexion à SAP B1 (${SAP_CLIENT} / ${SAP_USER})…`);
  const session = await sapLogin();
  console.log('[SyncSuppliers] Connecté. Récupération des fournisseurs…');

  let suppliers: SapSupplier[];
  try {
    suppliers = await fetchAllSuppliers(session);
  } finally {
    await sapLogout(session);
  }

  console.log(`[SyncSuppliers] ${suppliers.length} fournisseur(s) récupéré(s) depuis SAP.`);

  if (suppliers.length === 0) {
    console.log('[SyncSuppliers] Rien à synchroniser.');
    return;
  }

  console.log('[SyncSuppliers] Mise à jour de la base…');
  const { created, updated } = await upsertSuppliers(suppliers);

  const total = await prisma.supplierCache.count();
  console.log(`\n[SyncSuppliers] Terminé — ${created} créés, ${updated} mis à jour. Total en cache : ${total}`);
}

main()
  .catch((err: unknown) => {
    console.error('[SyncSuppliers] ERREUR :', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
