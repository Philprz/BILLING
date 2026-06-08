/**
 * Tests unitaires — ingestion d'une facture rectificative 384 liée à un litige.
 *
 * Couvre `writeInvoice` (apps/worker/src/ingestion/db-writer.ts) :
 *   - 384 + correctedInvoiceRef → originale DISPUTED trouvée : 384 créé (NEW, replaces),
 *     originale passée SUPERSEDED ; le dédoublon métier doc+fournisseur est CONTOURNÉ
 *     (même si n° identique à l'originale).
 *   - 384 sans originale DISPUTED → créé en TO_REVIEW + statusReason, pas de supersession.
 *   - 384 = renvoi identique (paMessageId ou SHA-256) → toujours ignoré (idempotence préservée).
 *   - Facture normale (380) avec n° déjà existant → toujours écartée comme doublon (inchangé).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock du client Prisma : le tx passé à $transaction est le prisma mocké lui-même.
vi.mock('@pa-sap-bridge/database', () => {
  const invoice = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const invoiceFile = { findFirst: vi.fn() };
  const prisma = {
    invoice,
    invoiceFile,
    $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
  };
  return { prisma };
});

// fs.unlinkSync est invoqué sur les chemins de dédoublon — neutralisé.
vi.mock('fs', () => ({ default: { unlinkSync: vi.fn() }, unlinkSync: vi.fn() }));

import { prisma } from '@pa-sap-bridge/database';
import { writeInvoice } from '../../apps/worker/src/ingestion/db-writer';
import type { ParsedInvoice } from '../../apps/worker/src/parsers/types';
import type { StoredFile } from '../../apps/worker/src/ingestion/file-store';

type Mocked = {
  invoice: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoiceFile: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};
const db = prisma as unknown as Mocked;

const storedFile: StoredFile = {
  absolutePath: '/tmp/inexistant-384.xml',
  sizeBytes: 1234n,
  sha256: 'sha-384',
};

function makeParsed(overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    format: 'UBL',
    direction: 'INVOICE',
    docNumberPa: 'DOC-001',
    docDate: '2026-06-01',
    dueDate: null,
    currency: 'EUR',
    supplierPaIdentifier: 'FR12404833048',
    supplierNameRaw: 'ACME SAS',
    totalExclTax: '100.00',
    totalTax: '20.00',
    totalInclTax: '120.00',
    prepaidAmount: null,
    allowanceTotal: null,
    chargeTotal: null,
    correctedInvoiceRef: null,
    typeTransaction: null,
    lines: [],
    supplierExtracted: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.invoice.findUnique.mockResolvedValue(null);
  db.invoiceFile.findFirst.mockResolvedValue(null);
  db.invoice.findFirst.mockResolvedValue(null);
  db.invoice.create.mockResolvedValue({ id: 'new-id' });
  db.invoice.update.mockResolvedValue({ id: 'orig-id' });
});

describe('writeInvoice — rectificative 384 liée à un litige', () => {
  it('384 + originale DISPUTED : crée le 384 (NEW, replaces) et supersède l’originale, même à n° identique', async () => {
    // 384 réutilisant le n° de l'originale : docNumberPa == correctedInvoiceRef
    const parsed = makeParsed({
      direction: 'CORRECTIVE_INVOICE',
      docNumberPa: 'DOC-ORIG-42',
      correctedInvoiceRef: 'DOC-ORIG-42',
    });
    db.invoice.findFirst.mockResolvedValueOnce({ id: 'orig-id' }); // recherche de l'originale DISPUTED

    const res = await writeInvoice(parsed, 'msg-384', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'new-id', created: true });

    // Recherche ciblée : fournisseur + docNumberPa == correctedInvoiceRef + status DISPUTED
    expect(db.invoice.findFirst).toHaveBeenCalledWith({
      where: {
        supplierPaIdentifier: 'FR12404833048',
        docNumberPa: 'DOC-ORIG-42',
        status: 'DISPUTED',
      },
      select: { id: true },
    });

    // Transaction : supersession de l'originale AVANT création du 384.
    // L'originale est réarmée pour la livraison PA (paStatusSentAt = null) afin que le
    // job ré-émette l'issue dérivée REJECTED malgré l'IN_DISPUTE déjà envoyé.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.invoice.update).toHaveBeenCalledWith({
      where: { id: 'orig-id' },
      data: {
        status: 'SUPERSEDED',
        statusReason: 'Remplacée par rectificative DOC-ORIG-42',
        paStatusSentAt: null,
      },
    });
    const createArg = db.invoice.create.mock.calls[0][0];
    expect(createArg.data.status).toBe('NEW');
    expect(createArg.data.replaces).toEqual({ connect: { id: 'orig-id' } });

    // Le dédoublon métier (findFirst sans status) n'a PAS été exécuté → un seul findFirst
    expect(db.invoice.findFirst).toHaveBeenCalledTimes(1);
  });

  it('384 sans originale DISPUTED : crée en TO_REVIEW avec statusReason, sans supersession', async () => {
    const parsed = makeParsed({
      direction: 'CORRECTIVE_INVOICE',
      docNumberPa: 'DOC-384',
      correctedInvoiceRef: 'DOC-INTROUVABLE',
    });
    db.invoice.findFirst.mockResolvedValueOnce(null); // aucune originale DISPUTED

    const res = await writeInvoice(parsed, 'msg-384b', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'new-id', created: true });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.invoice.update).not.toHaveBeenCalled();
    const createArg = db.invoice.create.mock.calls[0][0];
    expect(createArg.data.status).toBe('TO_REVIEW');
    expect(createArg.data.statusReason).toBe(
      'Rectificative 384 sans facture en litige correspondante (réf. DOC-INTROUVABLE)',
    );
    expect(createArg.data.replaces).toBeUndefined();
  });

  it('384 renvoyé à l’identique (paMessageId déjà connu) → ignoré (idempotence)', async () => {
    db.invoice.findUnique.mockResolvedValueOnce({ id: 'existing' });
    const parsed = makeParsed({
      direction: 'CORRECTIVE_INVOICE',
      docNumberPa: 'DOC-384',
      correctedInvoiceRef: 'DOC-ORIG',
    });

    const res = await writeInvoice(parsed, 'msg-dup', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'existing', created: false });
    expect(db.invoice.create).not.toHaveBeenCalled();
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it('384 renvoyé à l’identique (même SHA-256) → ignoré (doublon de contenu)', async () => {
    db.invoiceFile.findFirst.mockResolvedValueOnce({ invoiceId: 'existing-by-hash' });
    const parsed = makeParsed({
      direction: 'CORRECTIVE_INVOICE',
      docNumberPa: 'DOC-384',
      correctedInvoiceRef: 'DOC-ORIG',
    });

    const res = await writeInvoice(parsed, 'msg-h', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'existing-by-hash', created: false });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });
});

describe('writeInvoice — comportement non-384 inchangé', () => {
  it('380 avec n° déjà existant → écartée comme doublon métier', async () => {
    const parsed = makeParsed({ direction: 'INVOICE', docNumberPa: 'DOC-DEJA' });
    db.invoice.findFirst.mockResolvedValueOnce({ id: 'already' }); // dédoublon métier

    const res = await writeInvoice(parsed, 'msg-380', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'already', created: false });
    expect(db.invoice.create).not.toHaveBeenCalled();
    // Dédoublon métier classique : findFirst doc+fournisseur, sans filtre de statut
    expect(db.invoice.findFirst).toHaveBeenCalledWith({
      where: { docNumberPa: 'DOC-DEJA', supplierPaIdentifier: 'FR12404833048' },
      select: { id: true },
    });
  });

  it('380 inédite → créée normalement (status NEW par défaut)', async () => {
    const parsed = makeParsed({ direction: 'INVOICE', docNumberPa: 'DOC-NEUVE' });

    const res = await writeInvoice(parsed, 'msg-380b', 'CANAL-A', storedFile, 'r.xml');

    expect(res).toEqual({ invoiceId: 'new-id', created: true });
    const createArg = db.invoice.create.mock.calls[0][0];
    expect(createArg.data.status).toBe('NEW');
    expect(createArg.data.replaces).toBeUndefined();
  });
});
