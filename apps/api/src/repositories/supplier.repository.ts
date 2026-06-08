import { prisma } from '@pa-sap-bridge/database';

export interface SupplierCacheDto {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  taxId0: string | null;
  taxId1: string | null;
  taxId2: string | null;
  phone1: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  validFor: boolean;
  /** Identifiant PA (Plateforme Agréée) pour routage des factures électroniques. */
  pa_identifier: string | null;
  syncAt: string;
  lastSyncAt: string;
  invoiceCount: number;
}

export interface FindSuppliersParams {
  page: number;
  limit: number;
  search?: string;
}

export async function findSuppliers(
  params: FindSuppliersParams,
): Promise<{ items: SupplierCacheDto[]; total: number }> {
  const { page, limit, search } = params;
  const skip = (page - 1) * limit;

  // Exclure définitivement les orphelins de cache (validFor:false, absents du dernier
  // sync SAP) ET les alias déjà rattachés à un maître (table supplier_merges) : seul
  // le maître SAP reste visible. Cf. principe « le bon fournisseur est une fiche SAP ».
  const aliasRows = await prisma.supplierMerge.findMany({ select: { aliasCardcode: true } });
  const aliasCardcodes = aliasRows.map((r) => r.aliasCardcode);

  const baseWhere = {
    validFor: true,
    ...(aliasCardcodes.length ? { cardcode: { notIn: aliasCardcodes } } : {}),
  };
  const where = search
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { cardname: { contains: search, mode: 'insensitive' as const } },
              { cardcode: { contains: search, mode: 'insensitive' as const } },
              { federaltaxid: { contains: search, mode: 'insensitive' as const } },
              { vatregnum: { contains: search, mode: 'insensitive' as const } },
              { taxId0: { contains: search, mode: 'insensitive' as const } },
              { taxId1: { contains: search, mode: 'insensitive' as const } },
              { taxId2: { contains: search, mode: 'insensitive' as const } },
              { pa_identifier: { contains: search, mode: 'insensitive' as const } },
            ],
          },
        ],
      }
    : baseWhere;

  const [suppliers, total, countByCardcode] = await Promise.all([
    prisma.supplierCache.findMany({ where, skip, take: limit, orderBy: { cardname: 'asc' } }),
    prisma.supplierCache.count({ where }),
    prisma.invoice.groupBy({ by: ['supplierB1Cardcode'], _count: { id: true } }),
  ]);

  const countMap = new Map(countByCardcode.map((r) => [r.supplierB1Cardcode, r._count.id]));

  const items: SupplierCacheDto[] = suppliers.map((s) => ({
    id: s.id,
    cardcode: s.cardcode,
    cardname: s.cardname,
    federaltaxid: s.federaltaxid,
    vatregnum: s.vatregnum,
    taxId0: s.taxId0,
    taxId1: s.taxId1,
    taxId2: s.taxId2,
    phone1: s.phone1,
    email: s.email,
    address: s.address,
    city: s.city,
    zipCode: s.zipCode,
    country: s.country,
    validFor: s.validFor,
    pa_identifier: s.pa_identifier,
    syncAt: s.syncAt.toISOString(),
    lastSyncAt: s.lastSyncAt.toISOString(),
    invoiceCount: countMap.get(s.cardcode) ?? 0,
  }));

  return { items, total };
}

/**
 * Met à jour les identifiants fiscaux d'une ligne du cache fournisseur après un
 * PATCH SAP réussi. N'écrase QUE les champs explicitement fournis (les `undefined`
 * sont ignorés) ; une chaîne vide est normalisée en `null`. Retourne la ligne à jour.
 */
export async function updateSupplierCacheFiscal(
  cardCode: string,
  fields: { federaltaxid?: string; taxId0?: string; pa_identifier?: string },
): Promise<SupplierCacheDto> {
  const data: {
    federaltaxid?: string | null;
    taxId0?: string | null;
    pa_identifier?: string | null;
  } = {};
  if (fields.federaltaxid !== undefined) data.federaltaxid = fields.federaltaxid || null;
  if (fields.taxId0 !== undefined) data.taxId0 = fields.taxId0 || null;
  if (fields.pa_identifier !== undefined) data.pa_identifier = fields.pa_identifier || null;

  const [s, invoiceCount] = await Promise.all([
    prisma.supplierCache.update({
      where: { cardcode: cardCode },
      data: { ...data, syncAt: new Date() },
    }),
    prisma.invoice.count({ where: { supplierB1Cardcode: cardCode } }),
  ]);

  return {
    id: s.id,
    cardcode: s.cardcode,
    cardname: s.cardname,
    federaltaxid: s.federaltaxid,
    vatregnum: s.vatregnum,
    taxId0: s.taxId0,
    taxId1: s.taxId1,
    taxId2: s.taxId2,
    phone1: s.phone1,
    email: s.email,
    address: s.address,
    city: s.city,
    zipCode: s.zipCode,
    country: s.country,
    validFor: s.validFor,
    pa_identifier: s.pa_identifier,
    syncAt: s.syncAt.toISOString(),
    lastSyncAt: s.lastSyncAt.toISOString(),
    invoiceCount,
  };
}

// ─── Rattachement des doublons (alias → maître SAP) ──────────────────────────

/** Clé fiscale d'une fiche : TVA (federaltaxid) sinon SIRET (taxId0), trimmée. */
function fiscalKey(s: { federaltaxid: string | null; taxId0: string | null }): string {
  return (s.federaltaxid || s.taxId0 || '').trim();
}

export interface DuplicateGroupMember {
  cardcode: string;
  cardname: string;
  validFor: boolean;
  invoiceCount: number;
}

export interface DuplicateGroup {
  key: string;
  members: DuplicateGroupMember[];
}

/**
 * Groupes de fiches (≥ 2) partageant une clé fiscale, hors alias déjà rattachés.
 * Inclut les fiches `validFor:false` (orphelins de cache) afin que la réconciliation
 * puisse identifier le maître SAP unique et rattacher les orphelins. Le champ
 * `validFor` de chaque membre permet de distinguer maîtres et orphelins.
 */
export async function findDuplicateGroups(): Promise<DuplicateGroup[]> {
  const [fiches, aliasRows, countByCardcode] = await Promise.all([
    prisma.supplierCache.findMany({
      select: { cardcode: true, cardname: true, validFor: true, federaltaxid: true, taxId0: true },
    }),
    prisma.supplierMerge.findMany({ select: { aliasCardcode: true } }),
    prisma.invoice.groupBy({ by: ['supplierB1Cardcode'], _count: { id: true } }),
  ]);
  const aliasSet = new Set(aliasRows.map((r) => r.aliasCardcode));
  const countMap = new Map(countByCardcode.map((r) => [r.supplierB1Cardcode, r._count.id]));

  const groups = new Map<string, DuplicateGroupMember[]>();
  for (const f of fiches) {
    if (aliasSet.has(f.cardcode)) continue;
    const key = fiscalKey(f);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push({
      cardcode: f.cardcode,
      cardname: f.cardname,
      validFor: f.validFor,
      invoiceCount: countMap.get(f.cardcode) ?? 0,
    });
    groups.set(key, arr);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => ({ key, members }));
}

/**
 * Crée les mappings alias→maître (idempotent via upsert sur aliasCardcode), absorbe
 * les orphelins de cache partageant la clé fiscale du maître, et re-pointe toutes les
 * factures des alias vers le maître. Ne touche JAMAIS à SAP (le flag U_NOVA_Doublon
 * est posé côté route, qui détient la session SAP).
 */
export interface MergeRepoint {
  aliasCardcode: string;
  invoiceIds: string[];
}

export async function mergeSuppliers(params: {
  masterCardcode: string;
  aliasCardcodes: string[];
  reason?: string;
  createdBy?: string;
}): Promise<{ merged: number; invoicesRepointed: number; repoints: MergeRepoint[] }> {
  const { masterCardcode, aliasCardcodes, reason, createdBy } = params;

  const aliasSet = new Set(aliasCardcodes.filter((c) => c && c !== masterCardcode));

  // Absorber les orphelins (validFor:false) partageant la clé fiscale du maître.
  const master = await prisma.supplierCache.findUnique({
    where: { cardcode: masterCardcode },
    select: { federaltaxid: true, taxId0: true },
  });
  const masterKey = master ? fiscalKey(master) : '';
  if (masterKey) {
    const orphans = await prisma.supplierCache.findMany({
      where: {
        validFor: false,
        cardcode: { not: masterCardcode },
        OR: [{ federaltaxid: masterKey }, { taxId0: masterKey }],
      },
      select: { cardcode: true, federaltaxid: true, taxId0: true },
    });
    for (const o of orphans) {
      if (fiscalKey(o) === masterKey) aliasSet.add(o.cardcode);
    }
  }

  const allAliases = [...aliasSet];

  // Lire les factures concernées AVANT le repointage (détail par alias) → liste complète
  // persistée sur la ligne SupplierMerge (source de vérité de la ré-version) + trace d'audit.
  let repoints: MergeRepoint[] = [];
  let invoicesRepointed = 0;
  if (allAliases.length) {
    const affected = await prisma.invoice.findMany({
      where: { supplierB1Cardcode: { in: allAliases } },
      select: { id: true, supplierB1Cardcode: true },
    });
    invoicesRepointed = affected.length;
    repoints = allAliases.map((alias) => ({
      aliasCardcode: alias,
      invoiceIds: affected.filter((i) => i.supplierB1Cardcode === alias).map((i) => i.id),
    }));
  } else {
    repoints = [];
  }

  // Upsert du mapping par alias avec la liste COMPLÈTE (non plafonnée) des factures
  // repointées. En cas de re-rattachement, fusionne avec les IDs déjà mémorisés (dédupliqué).
  const repointByAlias = new Map(repoints.map((r) => [r.aliasCardcode, r.invoiceIds]));
  for (const alias of allAliases) {
    const newIds = repointByAlias.get(alias) ?? [];
    const existing = await prisma.supplierMerge.findUnique({
      where: { aliasCardcode: alias },
      select: { repointedInvoiceIds: true },
    });
    const prevIds = Array.isArray(existing?.repointedInvoiceIds)
      ? (existing!.repointedInvoiceIds as string[])
      : [];
    const mergedIds = Array.from(new Set([...prevIds, ...newIds]));
    await prisma.supplierMerge.upsert({
      where: { aliasCardcode: alias },
      create: {
        aliasCardcode: alias,
        masterCardcode,
        reason: reason ?? null,
        createdBy: createdBy ?? null,
        repointedInvoiceIds: newIds,
      },
      update: {
        masterCardcode,
        reason: reason ?? null,
        createdBy: createdBy ?? null,
        repointedInvoiceIds: mergedIds,
      },
    });
  }

  if (allAliases.length) {
    await prisma.invoice.updateMany({
      where: { supplierB1Cardcode: { in: allAliases } },
      data: { supplierB1Cardcode: masterCardcode },
    });
  }

  return { merged: allAliases.length, invoicesRepointed, repoints };
}

// ─── Plan de réconciliation (dry-run) ────────────────────────────────────────

export interface ReconcilePlanEntry {
  masterCardcode: string;
  masterName: string;
  aliases: DuplicateGroupMember[];
  invoicesToRepoint: number;
}

/**
 * Plan (lecture seule) des groupes à maître SAP UNIQUE (exactement 1 validFor:true) :
 * chaque entrée décrit le maître et les alias rattachables. Aucune écriture.
 */
export async function findReconcilePlan(): Promise<ReconcilePlanEntry[]> {
  const groups = await findDuplicateGroups();
  const plan: ReconcilePlanEntry[] = [];
  for (const group of groups) {
    const masters = group.members.filter((m) => m.validFor);
    if (masters.length !== 1) continue; // ambigu ou sans maître → hors plan auto
    const master = masters[0];
    const aliases = group.members.filter((m) => m.cardcode !== master.cardcode);
    if (aliases.length === 0) continue;
    plan.push({
      masterCardcode: master.cardcode,
      masterName: master.cardname,
      aliases,
      invoicesToRepoint: aliases.reduce((sum, a) => sum + a.invoiceCount, 0),
    });
  }
  return plan;
}

// ─── Liste & détachement des rattachements ───────────────────────────────────

export interface SupplierMergeItem {
  aliasCardcode: string;
  aliasName: string | null;
  masterCardcode: string;
  masterName: string | null;
  reason: string | null;
  createdAt: string;
}

/** Liste les rattachements actifs (SupplierMerge), enrichis du cardname si en cache. */
export async function listSupplierMerges(): Promise<SupplierMergeItem[]> {
  const merges = await prisma.supplierMerge.findMany({ orderBy: { createdAt: 'desc' } });
  const codes = [...new Set(merges.flatMap((m) => [m.aliasCardcode, m.masterCardcode]))];
  const fiches = codes.length
    ? await prisma.supplierCache.findMany({
        where: { cardcode: { in: codes } },
        select: { cardcode: true, cardname: true },
      })
    : [];
  const nameMap = new Map(fiches.map((f) => [f.cardcode, f.cardname]));
  return merges.map((m) => ({
    aliasCardcode: m.aliasCardcode,
    aliasName: nameMap.get(m.aliasCardcode) ?? null,
    masterCardcode: m.masterCardcode,
    masterName: nameMap.get(m.masterCardcode) ?? null,
    reason: m.reason,
    createdAt: m.createdAt.toISOString(),
  }));
}

/**
 * Détachement : re-réaffecte vers l'alias les factures (uniquement celles ENCORE sur
 * le maître — garde anti-écrasement d'une réaffectation manuelle ultérieure) puis
 * supprime le mapping. La liste des `invoiceIds` est lue sur la ligne `SupplierMerge`
 * (`repointedInvoiceIds`, non plafonnée) — l'audit n'est plus sollicité pour l'undo.
 * Retourne `null` si le mapping est introuvable (→ 404 côté route).
 */
export async function detachSupplier(
  aliasCardcode: string,
): Promise<{ masterCardcode: string; invoicesReverted: number } | null> {
  const merge = await prisma.supplierMerge.findUnique({ where: { aliasCardcode } });
  if (!merge) return null;

  const ids = Array.isArray(merge.repointedInvoiceIds)
    ? (merge.repointedInvoiceIds as string[])
    : [];
  let invoicesReverted = 0;
  if (ids.length) {
    const res = await prisma.invoice.updateMany({
      where: { id: { in: ids }, supplierB1Cardcode: merge.masterCardcode },
      data: { supplierB1Cardcode: aliasCardcode },
    });
    invoicesReverted = res.count;
  }
  await prisma.supplierMerge.delete({ where: { aliasCardcode } });
  return { masterCardcode: merge.masterCardcode, invoicesReverted };
}
