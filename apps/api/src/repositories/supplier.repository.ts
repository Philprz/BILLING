import { prisma } from '@pa-sap-bridge/database';

export interface SupplierCacheDto {
  id: string;
  cardcode: string;
  cardname: string;
  federaltaxid: string | null;
  vatregnum: string | null;
  syncAt: string;
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
    syncAt: s.syncAt.toISOString(),
    invoiceCount: countMap.get(s.cardcode) ?? 0,
  }));

  return { items, total };
}
