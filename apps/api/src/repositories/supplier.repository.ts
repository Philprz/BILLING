import { prisma } from '@pa-sap-bridge/database';

export interface SupplierCacheDto {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  syncAt: string;
}

export interface FindSuppliersParams {
  page: number;
  limit: number;
  search?: string;
}

function mapSupplier(s: {
  id: string; cardcode: string; cardname: string;
  federaltaxid: string | null; vatregnum: string | null; syncAt: Date;
}): SupplierCacheDto {
  return {
    id: s.id, cardcode: s.cardcode, cardname: s.cardname,
    federaltaxid: s.federaltaxid, vatregnum: s.vatregnum,
    syncAt: s.syncAt.toISOString(),
  };
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
        ],
      }
    : {};

  const [items, total] = await Promise.all([
    prisma.supplierCache.findMany({
      where, skip, take: limit, orderBy: { cardname: 'asc' },
    }),
    prisma.supplierCache.count({ where }),
  ]);

  return { items: items.map(mapSupplier), total };
}
