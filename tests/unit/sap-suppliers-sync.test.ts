import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pa-sap-bridge/database', () => ({
  createAuditLogBestEffort: vi.fn(),
  prisma: {
    supplierCache: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { findFirst: vi.fn() },
  },
}));

describe('sap suppliers sync service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.stubEnv('SAP_REST_BASE_URL', 'https://sap.example/b1s/v1');
  });

  it('maps SAP BusinessPartner fields to suppliers_cache shape without inventing missing fields', async () => {
    const { mapSapSupplierForCache } =
      await import('../../apps/api/src/services/sap-suppliers-sync.service');
    const syncedAt = new Date('2026-04-29T10:00:00.000Z');

    const mapped = mapSapSupplierForCache(
      {
        CardCode: 'F001',
        CardName: 'Alpha Services',
        CardType: 'cSupplier',
        FederalTaxID: 'FR12345678901',
        TaxId0: '12345678900012',
        Phone1: '0102030405',
        BPAddresses: [
          {
            AddressType: 'bo_BillTo',
            Street: '1 rue A',
            City: 'Paris',
            ZipCode: '75001',
            Country: 'FR',
          },
        ],
      },
      syncedAt,
    );

    expect(mapped).toMatchObject({
      cardcode: 'F001',
      cardname: 'Alpha Services',
      cardtype: 'cSupplier',
      federaltaxid: 'FR12345678901',
      vatregnum: null,
      taxId0: '12345678900012',
      phone1: '0102030405',
      address: '1 rue A',
      city: 'Paris',
      zipCode: '75001',
      country: 'FR',
      validFor: true,
      lastSyncAt: syncedAt,
    });
    expect(mapped.rawPayload).toMatchObject({ CardCode: 'F001' });
  });

  it('paginates BusinessPartners with @odata.nextLink', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('$skip=0')) {
        return new Response(
          JSON.stringify({
            value: [{ CardCode: 'F001', CardName: 'A' }],
            '@odata.nextLink': 'BusinessPartners?$skip=1',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ value: [{ CardCode: 'F002', CardName: 'B' }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchSuppliersFromSap } =
      await import('../../apps/api/src/services/sap-suppliers-sync.service');
    const rows = await fetchSuppliersFromSap('B1SESSION=test', 2);

    expect(rows.map((r) => r.CardCode)).toEqual(['F001', 'F002']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('upserts idempotently and disables suppliers absent from SAP', async () => {
    const db = await import('@pa-sap-bridge/database');
    const prisma = db.prisma as unknown as {
      supplierCache: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        updateMany: ReturnType<typeof vi.fn>;
      };
    };
    prisma.supplierCache.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cardcode: 'F002' });
    prisma.supplierCache.create.mockResolvedValue({});
    prisma.supplierCache.update.mockResolvedValue({});
    prisma.supplierCache.updateMany.mockResolvedValue({ count: 1 });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                { CardCode: 'F001', CardName: 'A', CardType: 'cSupplier' },
                { CardCode: 'F002', CardName: 'B', CardType: 'cSupplier' },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const { syncSuppliersFromSap } =
      await import('../../apps/api/src/services/sap-suppliers-sync.service');
    const result = await syncSuppliersFromSap('B1SESSION=test', 'manager');

    expect(result).toMatchObject({ inserted: 1, updated: 1, disabled: 1, total: 2, errors: [] });
    expect(prisma.supplierCache.create).toHaveBeenCalledTimes(1);
    expect(prisma.supplierCache.update).toHaveBeenCalledTimes(1);
    expect(prisma.supplierCache.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cardcode: { notIn: ['F001', 'F002'] } }),
      }),
    );
  });
});
