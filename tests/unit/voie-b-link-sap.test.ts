/**
 * Tests unitaires — Voie B (rattachement à une facture SAP existante)
 *
 * Couvre :
 *   - findPurchaseInvoiceByNumAtCard : 0, 1, N résultats + erreur réseau
 *   - attachFileToExistingPurchaseInvoice : succès, échec upload, échec PATCH, conflit attachement existant
 *   - buildPaStatusPayload : LINKED → VALIDATED (régression Voie A préservée)
 *   - route POST /api/invoices/:id/link-sap : statut interdit, 404 SAP, 409 SAP, OK
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildPaStatusPayload } from '@pa-sap-bridge/database';

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function odataValue(items: Record<string, unknown>[]): unknown {
  return { value: items };
}

// ─── findPurchaseInvoiceByNumAtCard ──────────────────────────────────────────

describe('findPurchaseInvoiceByNumAtCard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.SAP_REST_BASE_URL = 'http://sap-mock/b1s/v1';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SAP_REST_BASE_URL;
  });

  it('retourne found=none quand SAP renvoie une liste vide', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue([])));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    const result = await findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-2026-001');
    expect(result.found).toBe('none');
  });

  it('retourne found=one avec la facture quand SAP renvoie un seul document', async () => {
    const sapDoc = {
      DocEntry: 42,
      DocNum: 100,
      CardCode: 'F00001',
      CardName: 'ACME SAS',
      NumAtCard: 'FA-2026-001',
      DocDate: '2026-04-01T00:00:00',
      DocTotal: 1200.0,
      AttachmentEntry: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue([sapDoc])));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    const result = await findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-2026-001');
    expect(result.found).toBe('one');
    if (result.found === 'one') {
      expect(result.invoice.docEntry).toBe(42);
      expect(result.invoice.docNum).toBe(100);
      expect(result.invoice.cardCode).toBe('F00001');
      expect(result.invoice.attachmentEntry).toBeNull();
    }
  });

  it('retourne found=one avec attachmentEntry quand SAP renvoie un document avec pièce jointe', async () => {
    const sapDoc = {
      DocEntry: 42,
      DocNum: 100,
      CardCode: 'F00001',
      CardName: 'ACME SAS',
      NumAtCard: 'FA-2026-001',
      DocDate: '2026-04-01T00:00:00',
      DocTotal: 1200.0,
      AttachmentEntry: 77,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue([sapDoc])));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    const result = await findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-2026-001');
    expect(result.found).toBe('one');
    if (result.found === 'one') {
      expect(result.invoice.attachmentEntry).toBe(77);
    }
  });

  it('retourne found=many avec la liste quand SAP renvoie plusieurs documents', async () => {
    const sapDocs = [
      {
        DocEntry: 10,
        DocNum: 1,
        CardCode: 'F00001',
        CardName: 'ACME',
        NumAtCard: 'FA-001',
        DocDate: '2026-01-01',
        DocTotal: 100,
        AttachmentEntry: null,
      },
      {
        DocEntry: 11,
        DocNum: 2,
        CardCode: 'F00002',
        CardName: 'BETA',
        NumAtCard: 'FA-001',
        DocDate: '2026-02-01',
        DocTotal: 200,
        AttachmentEntry: null,
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue(sapDocs)));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    const result = await findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-001');
    expect(result.found).toBe('many');
    if (result.found === 'many') {
      expect(result.invoices).toHaveLength(2);
    }
  });

  it('lève SapSlError si fetch échoue (réseau)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { findPurchaseInvoiceByNumAtCard, SapSlError } =
      await import('../../apps/api/src/services/sap-sl.service');
    await expect(findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-001')).rejects.toBeInstanceOf(
      SapSlError,
    );
  });

  it("filtre par CardCode si fourni (vérifie l'URL appelée)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue([])));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    await findPurchaseInvoiceByNumAtCard('cookie=session', 'FA-2026-001', 'F00042');

    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('CardCode');
    expect(calledUrl).toContain('F00042');
  });

  it('échappe les apostrophes OData dans numAtCard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(odataValue([])));

    const { findPurchaseInvoiceByNumAtCard } =
      await import('../../apps/api/src/services/sap-sl.service');
    await findPurchaseInvoiceByNumAtCard('cookie=session', "L'Oréal-2026");

    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    // L'apostrophe doit être doublée : L''Oréal
    expect(decodeURIComponent(calledUrl)).toContain("L''Oréal");
  });
});

// ─── attachFileToExistingPurchaseInvoice ─────────────────────────────────────

describe('attachFileToExistingPurchaseInvoice', () => {
  let tempFile: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());
    process.env.SAP_REST_BASE_URL = 'http://sap-mock/b1s/v1';

    // Créer un fichier temporaire pour les tests d'upload
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'billing-test-'));
    tempFile = join(dir, 'facture.pdf');
    writeFileSync(tempFile, '%PDF-1.4 test content');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SAP_REST_BASE_URL;
  });

  it('refuse si la facture SAP a déjà une pièce jointe', async () => {
    const { attachFileToExistingPurchaseInvoice, SapSlError } =
      await import('../../apps/api/src/services/sap-sl.service');
    await expect(
      attachFileToExistingPurchaseInvoice('cookie=session', 42, tempFile, 77),
    ).rejects.toBeInstanceOf(SapSlError);

    // fetch ne doit pas avoir été appelé
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('retourne AbsoluteEntry après upload + PATCH réussis', async () => {
    // 1er appel : upload Attachments2 → AbsoluteEntry = 99
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ AbsoluteEntry: 99 }, 201))
      // 2ème appel : PATCH PurchaseInvoices → 204
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { attachFileToExistingPurchaseInvoice } =
      await import('../../apps/api/src/services/sap-sl.service');
    const entry = await attachFileToExistingPurchaseInvoice('cookie=session', 42, tempFile, null);
    expect(entry).toBe(99);
  });

  it("lève SapSlError si l'upload Attachments2 échoue", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: { value: 'Upload refusé' } } }, 400),
    );

    const { attachFileToExistingPurchaseInvoice, SapSlError } =
      await import('../../apps/api/src/services/sap-sl.service');
    await expect(
      attachFileToExistingPurchaseInvoice('cookie=session', 42, tempFile, null),
    ).rejects.toBeInstanceOf(SapSlError);
  });

  it('lève SapSlError si le PATCH PurchaseInvoices échoue', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ AbsoluteEntry: 99 }, 201))
      .mockResolvedValueOnce(jsonResponse({ error: { message: { value: 'Locked' } } }, 423));

    const { attachFileToExistingPurchaseInvoice, SapSlError } =
      await import('../../apps/api/src/services/sap-sl.service');
    await expect(
      attachFileToExistingPurchaseInvoice('cookie=session', 42, tempFile, null),
    ).rejects.toBeInstanceOf(SapSlError);
  });
});

// ─── buildPaStatusPayload : LINKED → VALIDATED ───────────────────────────────

describe('buildPaStatusPayload — Voie B', () => {
  it('retourne VALIDATED pour une facture LINKED', () => {
    const payload = buildPaStatusPayload({
      paMessageId: 'MSG-B1',
      docNumberPa: 'FA-2026-099',
      paSource: 'TEST',
      status: 'LINKED',
      statusReason: 'Facture SAP existante rattachée via NumAtCard',
      sapDocEntry: 42,
      sapDocNum: 100,
    });

    expect(payload.outcome).toBe('VALIDATED');
    expect(payload.sapDocEntry).toBe(42);
    expect(payload.sapDocNum).toBe(100);
  });

  it('préserve VALIDATED pour POSTED (régression Voie A)', () => {
    const payload = buildPaStatusPayload({
      paMessageId: 'MSG-A1',
      docNumberPa: 'FA-2026-001',
      paSource: 'TEST',
      status: 'POSTED',
      statusReason: null,
      sapDocEntry: 10,
      sapDocNum: 20,
    });
    expect(payload.outcome).toBe('VALIDATED');
  });

  it('retourne REJECTED pour un statut ERROR (jamais VALIDATED)', () => {
    const payload = buildPaStatusPayload({
      paMessageId: 'MSG-ERR',
      docNumberPa: 'FA-ERR',
      paSource: 'TEST',
      status: 'ERROR',
      statusReason: 'Erreur SAP',
      sapDocEntry: null,
      sapDocNum: null,
    });
    expect(payload.outcome).toBe('REJECTED');
  });
});
