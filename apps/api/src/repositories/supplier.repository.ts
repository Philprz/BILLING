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

  const where = search
    ? {
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
      }
    : {};

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
