import fs from 'fs';
import { prisma } from '@pa-sap-bridge/database';
import type { InvoiceStatus } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { dec, decOrNull, bigInt, isoDate, isoDateOrNull } from '../lib/serialize';
import { parseInvoiceXml } from '../services/xml-parser.service';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export interface InvoiceSummaryDto {
  id: string;
  paMessageId: string;
  paSource: string;
  direction: string;
  format: string;
  receivedAt: string;
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  supplierB1Cardcode: string | null;
  supplierMatchConfidence: number;
  supplierMatchReason: string | null;
  docNumberPa: string;
  docDate: string;
  dueDate: string | null;
  currency: string;
  totalExclTax: number;
  totalTax: number;
  totalInclTax: number;
  status: string;
  statusReason: string | null;
  integrationMode: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sapAttachmentEntry: number | null;
  paStatusSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLineDto {
  id: string;
  lineNo: number;
  description: string;
  quantity: number;
  unitPrice: number;
  amountExclTax: number;
  taxCode: string | null;
  taxRate: number | null;
  taxAmount: number;
  amountInclTax: number;
  suggestedAccountCode: string | null;
  suggestedAccountConfidence: number;
  suggestedCostCenter: string | null;
  suggestedTaxCodeB1: string | null;
  suggestionSource: string | null;
  chosenAccountCode: string | null;
  chosenCostCenter: string | null;
  chosenTaxCodeB1: string | null;
  taxCodeLockedByUser: boolean;
}

export interface InvoiceFileDto {
  id: string;
  kind: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface InvoiceDetailDto extends InvoiceSummaryDto {
  lines: InvoiceLineDto[];
  files: InvoiceFileDto[];
  supplierInCache: boolean | null; // null = pas de CardCode assigné
  supplierExtracted: Record<string, unknown> | null;
}

// ─── Params ──────────────────────────────────────────────────────────────────

export interface FindInvoicesParams {
  page: number;
  limit: number;
  status?: InvoiceStatus | InvoiceStatus[];
  paSource?: string;
  supplierCardcode?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  direction?: 'INVOICE' | 'CREDIT_NOTE';
  amountMin?: number;
  amountMax?: number;
  sortBy?: 'receivedAt' | 'docDate' | 'totalInclTax' | 'status' | 'supplierNameRaw';
  sortDir?: 'asc' | 'desc';
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapSummary(inv: {
  id: string;
  paMessageId: string;
  paSource: string;
  direction: string;
  format: string;
  receivedAt: Date;
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  supplierB1Cardcode: string | null;
  supplierMatchConfidence: number;
  supplierMatchReason: string | null;
  docNumberPa: string;
  docDate: Date;
  dueDate: Date | null;
  currency: string;
  totalExclTax: import('@prisma/client').Prisma.Decimal;
  totalTax: import('@prisma/client').Prisma.Decimal;
  totalInclTax: import('@prisma/client').Prisma.Decimal;
  status: string;
  statusReason: string | null;
  integrationMode: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sapAttachmentEntry: number | null;
  paStatusSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): InvoiceSummaryDto {
  return {
    id: inv.id,
    paMessageId: inv.paMessageId,
    paSource: inv.paSource,
    direction: inv.direction,
    format: inv.format,
    receivedAt: inv.receivedAt.toISOString(),
    supplierPaIdentifier: inv.supplierPaIdentifier,
    supplierNameRaw: inv.supplierNameRaw,
    supplierB1Cardcode: inv.supplierB1Cardcode,
    supplierMatchConfidence: inv.supplierMatchConfidence,
    supplierMatchReason: inv.supplierMatchReason,
    docNumberPa: inv.docNumberPa,
    docDate: isoDate(inv.docDate),
    dueDate: isoDateOrNull(inv.dueDate),
    currency: inv.currency,
    totalExclTax: dec(inv.totalExclTax),
    totalTax: dec(inv.totalTax),
    totalInclTax: dec(inv.totalInclTax),
    status: inv.status,
    statusReason: inv.statusReason,
    integrationMode: inv.integrationMode,
    sapDocEntry: inv.sapDocEntry,
    sapDocNum: inv.sapDocNum,
    sapAttachmentEntry: inv.sapAttachmentEntry,
    paStatusSentAt: inv.paStatusSentAt ? inv.paStatusSentAt.toISOString() : null,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  };
}

function mapLine(l: {
  id: string;
  lineNo: number;
  description: string;
  quantity: import('@prisma/client').Prisma.Decimal;
  unitPrice: import('@prisma/client').Prisma.Decimal;
  amountExclTax: import('@prisma/client').Prisma.Decimal;
  taxCode: string | null;
  taxRate: import('@prisma/client').Prisma.Decimal | null;
  taxAmount: import('@prisma/client').Prisma.Decimal;
  amountInclTax: import('@prisma/client').Prisma.Decimal;
  suggestedAccountCode: string | null;
  suggestedAccountConfidence: number;
  suggestedCostCenter: string | null;
  suggestedTaxCodeB1: string | null;
  suggestionSource: string | null;
  chosenAccountCode: string | null;
  chosenCostCenter: string | null;
  chosenTaxCodeB1: string | null;
  taxCodeLockedByUser: boolean;
}): InvoiceLineDto {
  return {
    id: l.id,
    lineNo: l.lineNo,
    description: l.description,
    quantity: dec(l.quantity),
    unitPrice: dec(l.unitPrice),
    amountExclTax: dec(l.amountExclTax),
    taxCode: l.taxCode,
    taxRate: decOrNull(l.taxRate),
    taxAmount: dec(l.taxAmount),
    amountInclTax: dec(l.amountInclTax),
    suggestedAccountCode: l.suggestedAccountCode,
    suggestedAccountConfidence: l.suggestedAccountConfidence,
    suggestedCostCenter: l.suggestedCostCenter,
    suggestedTaxCodeB1: l.suggestedTaxCodeB1,
    suggestionSource: l.suggestionSource,
    chosenAccountCode: l.chosenAccountCode,
    chosenCostCenter: l.chosenCostCenter,
    chosenTaxCodeB1: l.chosenTaxCodeB1,
    taxCodeLockedByUser: l.taxCodeLockedByUser,
  };
}

function mapFile(f: {
  id: string;
  kind: string;
  path: string;
  sizeBytes: bigint;
  sha256: string;
}): InvoiceFileDto {
  return { id: f.id, kind: f.kind, path: f.path, sizeBytes: bigInt(f.sizeBytes), sha256: f.sha256 };
}

function needsSupplierExtractedBackfill(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const data = value as Record<string, unknown>;
  return [
    data.siret,
    data.siren,
    data.vatNumber,
    data.street,
    data.city,
    data.postalCode,
    data.country,
    data.email,
    data.phone,
  ].every((v) => v === null || v === undefined || v === '');
}

async function backfillSupplierExtractedFromXml(inv: {
  id: string;
  supplierExtracted: Prisma.JsonValue | null;
  files: { kind: string; path: string }[];
}): Promise<Record<string, unknown> | null> {
  if (!needsSupplierExtractedBackfill(inv.supplierExtracted)) {
    return inv.supplierExtracted as Record<string, unknown>;
  }

  const xmlFile = inv.files.find((file) => file.kind === 'XML' && fs.existsSync(file.path));
  if (!xmlFile) return (inv.supplierExtracted as Record<string, unknown> | null) ?? null;

  try {
    const parsed = parseInvoiceXml(fs.readFileSync(xmlFile.path, 'utf8'), xmlFile.path);
    if (!parsed.supplierExtracted) return null;

    await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        supplierExtracted: parsed.supplierExtracted as unknown as Prisma.InputJsonValue,
      },
    });

    return parsed.supplierExtracted as unknown as Record<string, unknown>;
  } catch {
    return (inv.supplierExtracted as Record<string, unknown> | null) ?? null;
  }
}

// ─── Requêtes ─────────────────────────────────────────────────────────────────

const SORT_FIELDS = {
  receivedAt: 'receivedAt',
  docDate: 'docDate',
  totalInclTax: 'totalInclTax',
  status: 'status',
  supplierNameRaw: 'supplierNameRaw',
} as const;

export async function findInvoices(
  params: FindInvoicesParams,
): Promise<{ items: InvoiceSummaryDto[]; total: number }> {
  const {
    page,
    limit,
    status,
    paSource,
    supplierCardcode,
    dateFrom,
    dateTo,
    search,
    direction,
    amountMin,
    amountMax,
    sortBy = 'receivedAt',
    sortDir = 'desc',
  } = params;
  const skip = (page - 1) * limit;

  const where = {
    ...(status ? (Array.isArray(status) ? { status: { in: status } } : { status }) : {}),
    ...(paSource ? { paSource } : {}),
    ...(supplierCardcode ? { supplierB1Cardcode: supplierCardcode } : {}),
    ...(direction ? { direction } : {}),
    ...(amountMin !== undefined || amountMax !== undefined
      ? {
          totalInclTax: {
            ...(amountMin !== undefined ? { gte: amountMin } : {}),
            ...(amountMax !== undefined ? { lte: amountMax } : {}),
          },
        }
      : {}),
    ...(dateFrom || dateTo
      ? {
          docDate: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {}),
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { supplierNameRaw: { contains: search, mode: 'insensitive' as const } },
            { docNumberPa: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const orderBy = { [SORT_FIELDS[sortBy]]: sortDir };

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({ where, orderBy, skip, take: limit }),
    prisma.invoice.count({ where }),
  ]);

  return { items: items.map(mapSummary), total };
}

export async function findInvoiceById(id: string): Promise<InvoiceDetailDto | null> {
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNo: 'asc' } },
      files: true,
    },
  });
  if (!inv) return null;

  const supplierInCache = inv.supplierB1Cardcode
    ? (await prisma.supplierCache.count({ where: { cardcode: inv.supplierB1Cardcode } })) > 0
    : null;
  const supplierExtracted = await backfillSupplierExtractedFromXml(inv);

  return {
    ...mapSummary(inv),
    lines: inv.lines.map(mapLine),
    files: inv.files.map(mapFile),
    supplierInCache,
    supplierExtracted,
  };
}

export async function findInvoiceFiles(invoiceId: string): Promise<InvoiceFileDto[] | null> {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true } });
  if (!inv) return null;
  const files = await prisma.invoiceFile.findMany({ where: { invoiceId } });
  return files.map(mapFile);
}
