import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { fetchChartOfAccounts, type AccountEntry } from './sap-sl.service';

export interface CachedAccount {
  acctCode: string;
  acctName: string;
  activeAccount: boolean;
  postable: boolean;
  accountLevel: number | null;
  groupMask: number | null;
}

export interface AccountValidationResult {
  ok: boolean;
  reason: string | null;
  account: CachedAccount | null;
}

export async function syncChartOfAccountsCache(
  sapSessionCookie: string,
): Promise<{ count: number; activePostable: number; syncedAt: Date }> {
  const accounts = await fetchChartOfAccounts(sapSessionCookie);
  const syncedAt = new Date();

  console.log(`[syncChartOfAccounts] ${accounts.length} compte(s) récupéré(s) depuis SAP B1`);
  const activePostable = accounts.filter((a) => a.activeAccount && a.postable).length;
  console.log(
    `[syncChartOfAccounts] ${activePostable} compte(s) conservé(s) après filtre actif+imputable`,
  );

  await prisma.$transaction(
    accounts.map((account) =>
      prisma.chartOfAccountCache.upsert({
        where: { acctCode: account.acctCode },
        update: {
          acctName: account.acctName,
          activeAccount: account.activeAccount,
          postable: account.postable,
          accountLevel: account.accountLevel,
          groupMask: account.groupMask,
          syncAt: syncedAt,
        },
        create: {
          acctCode: account.acctCode,
          acctName: account.acctName,
          activeAccount: account.activeAccount,
          postable: account.postable,
          accountLevel: account.accountLevel,
          groupMask: account.groupMask,
          syncAt: syncedAt,
        },
      }),
    ),
  );

  return { count: accounts.length, activePostable, syncedAt };
}

export async function searchCachedAccounts(query: string): Promise<CachedAccount[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  const isCodePrefix = /^\d+$/.test(q);
  const where = isCodePrefix
    ? {
        activeAccount: true,
        postable: true,
        acctCode: { startsWith: q },
      }
    : {
        activeAccount: true,
        postable: true,
        OR: [
          { acctCode: { contains: q, mode: 'insensitive' as const } },
          { acctName: { contains: q, mode: 'insensitive' as const } },
        ],
      };

  const rows = await prisma.chartOfAccountCache.findMany({
    where,
    orderBy: [{ acctCode: 'asc' }],
    take: 50,
  });

  return rows.map(mapCachedAccount);
}

export async function listCachedAccounts(limit = 500): Promise<CachedAccount[]> {
  const rows = await prisma.chartOfAccountCache.findMany({
    where: { activeAccount: true, postable: true },
    orderBy: [{ acctCode: 'asc' }],
    take: limit,
  });
  return rows.map(mapCachedAccount);
}

export async function validateCachedAccount(
  accountCode: string | null | undefined,
): Promise<AccountValidationResult> {
  const code = accountCode?.trim();
  if (!code) return { ok: false, reason: 'Compte comptable manquant', account: null };

  const account = await prisma.chartOfAccountCache.findUnique({ where: { acctCode: code } });
  if (!account) {
    return { ok: false, reason: 'Compte inexistant dans SAP B1', account: null };
  }
  if (!account.activeAccount) {
    return { ok: false, reason: 'Compte inactif dans SAP B1', account: mapCachedAccount(account) };
  }
  if (!account.postable) {
    return { ok: false, reason: 'Compte non imputable', account: mapCachedAccount(account) };
  }

  return { ok: true, reason: null, account: mapCachedAccount(account) };
}

/**
 * Retourne les comptes actifs+imputables les plus proches du code invalide.
 * Tri : même classe comptable (1er caractère) en priorité, puis préfixe commun
 * le plus long, puis ordre alphabétique du code.
 */
export async function findClosestAccounts(
  invalidCode: string,
  limit = 3,
): Promise<CachedAccount[]> {
  if (!invalidCode) return [];

  let rows: Awaited<ReturnType<typeof prisma.chartOfAccountCache.findMany>>;
  try {
    // Filtre d'abord sur la même classe (1er caractère) pour limiter les données
    rows = await prisma.chartOfAccountCache.findMany({
      where: {
        activeAccount: true,
        postable: true,
        acctCode: { startsWith: invalidCode[0] },
      },
      orderBy: [{ acctCode: 'asc' }],
    });
    // Fallback si la classe est inconnue
    if (rows.length === 0) {
      rows = await prisma.chartOfAccountCache.findMany({
        where: { activeAccount: true, postable: true },
        orderBy: [{ acctCode: 'asc' }],
      });
    }
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  function commonPrefixLen(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  const scored = rows
    .map((r) => ({ r, score: commonPrefixLen(r.acctCode, invalidCode) }))
    .sort((a, b) => b.score - a.score || a.r.acctCode.localeCompare(b.r.acctCode));

  return scored.slice(0, limit).map((s) => mapCachedAccount(s.r));
}

export async function isCachePopulated(): Promise<boolean> {
  try {
    return (await prisma.chartOfAccountCache.count()) > 0;
  } catch {
    return false;
  }
}

export async function getCachedAccountsByCode(
  accountCodes: string[],
): Promise<Map<string, CachedAccount>> {
  const unique = [...new Set(accountCodes.map((c) => c.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.chartOfAccountCache.findMany({ where: { acctCode: { in: unique } } });
  return new Map(rows.map((row) => [row.acctCode, mapCachedAccount(row)]));
}

function mapCachedAccount(row: {
  acctCode: string;
  acctName: string;
  activeAccount: boolean;
  postable: boolean;
  accountLevel: number | null;
  groupMask: number | null;
}): CachedAccount {
  return {
    acctCode: row.acctCode,
    acctName: row.acctName,
    activeAccount: row.activeAccount,
    postable: row.postable,
    accountLevel: row.accountLevel,
    groupMask: row.groupMask,
  };
}

export function mapSapAccountForCache(
  account: AccountEntry,
): Prisma.ChartOfAccountCacheCreateManyInput {
  return {
    acctCode: account.acctCode,
    acctName: account.acctName,
    activeAccount: account.activeAccount,
    postable: account.postable,
    accountLevel: account.accountLevel,
    groupMask: account.groupMask,
  };
}
