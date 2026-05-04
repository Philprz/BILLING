import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@pa-sap-bridge/database';
import { buildAuthenticatedApp } from '../helpers/http';

describe.sequential('API suppliers sync', () => {
  let snapshot: Awaited<ReturnType<typeof prisma.supplierCache.findMany>> = [];

  function sapRowFromCache(row: (typeof snapshot)[number]): Record<string, unknown> {
    return {
      CardCode: row.cardcode,
      CardName: row.cardname,
      CardType: row.cardtype ?? 'cSupplier',
      FederalTaxID: row.federaltaxid,
      VATRegistrationNumber: row.vatregnum,
      TaxId0: row.taxId0,
      TaxId1: row.taxId1,
      TaxId2: row.taxId2,
      Phone1: row.phone1,
      EmailAddress: row.email,
      Valid: row.validFor ? 'tYES' : 'tNO',
      BPAddresses: [
        {
          AddressType: 'bo_BillTo',
          Street: row.address,
          City: row.city,
          ZipCode: row.zipCode,
          Country: row.country,
        },
      ],
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.supplierCache.deleteMany({ where: { cardcode: { in: ['F_IT_SYNC'] } } });
    for (const row of snapshot) {
      await prisma.supplierCache.update({
        where: { cardcode: row.cardcode },
        data: {
          cardname: row.cardname,
          cardtype: row.cardtype,
          federaltaxid: row.federaltaxid,
          vatregnum: row.vatregnum,
          taxId0: row.taxId0,
          taxId1: row.taxId1,
          taxId2: row.taxId2,
          phone1: row.phone1,
          email: row.email,
          address: row.address,
          city: row.city,
          zipCode: row.zipCode,
          country: row.country,
          validFor: row.validFor,
          rawPayload: row.rawPayload,
          syncAt: row.syncAt,
          lastSyncAt: row.lastSyncAt,
          pa_identifier: row.pa_identifier,
        },
      });
    }
    snapshot = [];
  });

  it('POST /api/suppliers/sync imports SAP suppliers and GET /api/suppliers/search reads local cache', async () => {
    const { app, cookieHeader, csrfToken } = await buildAuthenticatedApp('sync.user');
    snapshot = await prisma.supplierCache.findMany();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                ...snapshot.map(sapRowFromCache),
                {
                  CardCode: 'F_IT_SYNC',
                  CardName: 'Integration Supplier',
                  CardType: 'cSupplier',
                  TaxId0: '12345678900012',
                  FederalTaxID: 'FR12345678901',
                  BPAddresses: [{ AddressType: 'bo_BillTo', City: 'Paris', Country: 'FR' }],
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const syncResponse = await app.inject({
      method: 'POST',
      url: '/api/suppliers/sync',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json().data).toMatchObject({ inserted: 1, total: snapshot.length + 1 });

    const searchResponse = await app.inject({
      method: 'GET',
      url: '/api/suppliers/search?q=12345678900012',
      headers: { cookie: cookieHeader },
    });

    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.json().data.items[0]).toMatchObject({
      cardcode: 'F_IT_SYNC',
      cardname: 'Integration Supplier',
      taxId0: '12345678900012',
      city: 'Paris',
      country: 'FR',
    });

    await app.close();
  });
});
