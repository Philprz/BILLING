/**
 * POST /api/invoices/upload
 * Import manuel d'une facture XML (UBL / CII), PDF ou ZIP (XML+PDF) via multipart/form-data.
 *
 * ZIP : doit contenir exactement un fichier .xml et optionnellement un .pdf.
 *       Le XML fournit toutes les données structurées (lignes, montants).
 *       Le PDF est stocké comme pièce jointe visuelle séparée.
 *       Format STORE uniquement (tel que produit par le générateur BILLING).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { requireSession } from '../middleware/require-session';
import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import { enrichInvoiceById } from '../services/enrichment.service';
import { parseInvoiceXml } from '../services/xml-parser.service';

const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH
  ? path.resolve(process.env.FILE_STORAGE_PATH)
  : path.join(process.cwd(), 'data');
const INVOICES_PATH = path.join(FILE_STORAGE_PATH, 'invoices');
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

// ─── Lecteur ZIP minimal (méthode STORE uniquement) ───────────────────────────
// Compatible avec les ZIP produits par createZipBuffer() du générateur.

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset <= buf.length - 30) {
    // Signature local file header: PK\x03\x04
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;

    const compressionMethod = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataOffset = offset + 30 + nameLength + extraLength;

    if (compressionMethod === 0 /* STORE */) {
      entries.push({
        name,
        data: Buffer.from(buf.subarray(dataOffset, dataOffset + uncompressedSize)),
      });
    }
    // Avance même si compressé (on ignore ces entrées)
    offset = dataOffset + compressedSize;
  }

  return entries;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

  app.post('/api/invoices/upload', { preHandler: requireSession }, async (request, reply) => {
    const { sapUser } = request.sapSession!;
    const data = await request.file();

    if (!data) return reply.code(400).send({ success: false, error: 'Aucun fichier reçu.' });

    const originalName = data.filename;
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== '.xml' && ext !== '.pdf' && ext !== '.zip') {
      await data.toBuffer();
      return reply.code(400).send({
        success: false,
        error: `Extension non supportée : ${ext}. Formats acceptés : .xml, .pdf, .zip (XML + PDF)`,
      });
    }

    const buf = await data.toBuffer();
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const tmpPath = path.join(os.tmpdir(), `pa-upload-${sha256.slice(0, 12)}${ext}`);
    fs.writeFileSync(tmpPath, buf);

    try {
      const yearMonth = new Date().toISOString().slice(0, 7);
      const destDir = path.join(INVOICES_PATH, yearMonth);
      fs.mkdirSync(destDir, { recursive: true });

      let parsed: ReturnType<typeof parseInvoiceXml> | ReturnType<typeof buildPdfOnly>;
      let primaryPath: string;
      let primaryKind: 'XML' | 'PDF';
      let extraFile: { path: string; kind: 'PDF'; sizeBytes: bigint; sha256: string } | null = null;

      if (ext === '.zip') {
        // ── ZIP : extraire XML + PDF ─────────────────────────────────────────
        const entries = readZipEntries(buf);
        const xmlEntry = entries.find((e) => e.name.toLowerCase().endsWith('.xml'));
        const pdfEntry = entries.find((e) => e.name.toLowerCase().endsWith('.pdf'));

        if (!xmlEntry) {
          return reply.code(422).send({
            success: false,
            error:
              'Le ZIP ne contient pas de fichier XML. Le générateur BILLING produit un ZIP avec un .xml et un .pdf — vérifiez le fichier.',
          });
        }

        // Parse le XML pour les données structurées
        const baseName = xmlEntry.name.replace(/\.[^.]+$/, '');
        parsed = parseInvoiceXml(xmlEntry.data.toString('utf-8'), baseName);

        // Stocke le XML
        const xmlDest = path.join(destDir, `MANUAL-${Date.now()}-${path.basename(xmlEntry.name)}`);
        fs.writeFileSync(xmlDest, xmlEntry.data);
        primaryPath = xmlDest;
        primaryKind = 'XML';

        // Stocke le PDF si présent
        if (pdfEntry) {
          const pdfDest = path.join(
            destDir,
            `MANUAL-${Date.now() + 1}-${path.basename(pdfEntry.name)}`,
          );
          fs.writeFileSync(pdfDest, pdfEntry.data);
          extraFile = {
            path: pdfDest,
            kind: 'PDF',
            sizeBytes: BigInt(pdfEntry.data.length),
            sha256: crypto.createHash('sha256').update(pdfEntry.data).digest('hex'),
          };
        }
      } else if (ext === '.pdf') {
        // ── PDF seul : entrée minimale sans lignes ────────────────────────────
        const baseName = originalName.replace(/\.[^.]+$/, '');
        parsed = buildPdfOnly(baseName);

        const destPath = path.join(destDir, `MANUAL-${Date.now()}-${originalName}`);
        fs.copyFileSync(tmpPath, destPath);
        primaryPath = destPath;
        primaryKind = 'PDF';
      } else {
        // ── XML ───────────────────────────────────────────────────────────────
        const baseName = originalName.replace(/\.[^.]+$/, '');
        parsed = parseInvoiceXml(buf.toString('utf-8'), baseName);

        const destPath = path.join(destDir, `MANUAL-${Date.now()}-${originalName}`);
        fs.copyFileSync(tmpPath, destPath);
        primaryPath = destPath;
        primaryKind = 'XML';
      }

      const paMessageId = `MANUAL:${sha256.slice(0, 16)}`;

      // Idempotence par paMessageId (hash contenu)
      const existing = await prisma.invoice.findUnique({
        where: { paMessageId },
        select: { id: true },
      });
      if (existing) {
        return reply.send({ success: true, data: { invoiceId: existing.id, created: false } });
      }

      // Doublon métier — même numéro de document + même fournisseur
      const existingByDocNum = await prisma.invoice.findFirst({
        where: {
          docNumberPa: parsed.docNumberPa,
          supplierPaIdentifier: parsed.supplierPaIdentifier,
        },
        select: { id: true },
      });
      if (existingByDocNum) {
        return reply.send({
          success: true,
          data: { invoiceId: existingByDocNum.id, created: false },
        });
      }

      const primaryFile = {
        kind: primaryKind,
        path: primaryPath,
        sizeBytes: BigInt(buf.byteLength),
        sha256,
      };
      const filesCreate = extraFile ? [primaryFile, extraFile] : [primaryFile];

      const invoice = await prisma.invoice.create({
        data: {
          paMessageId,
          paSource: 'MANUAL_UPLOAD',
          direction: parsed.direction,
          format: parsed.format as never,
          supplierPaIdentifier: parsed.supplierPaIdentifier,
          supplierNameRaw: parsed.supplierNameRaw,
          supplierExtracted:
            'supplierExtracted' in parsed && parsed.supplierExtracted
              ? (parsed.supplierExtracted as unknown as Prisma.InputJsonValue)
              : undefined,
          supplierMatchConfidence: 0,
          docNumberPa: parsed.docNumberPa,
          docDate: new Date(parsed.docDate),
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
          currency: parsed.currency,
          totalExclTax: parsed.totalExclTax,
          totalTax: parsed.totalTax,
          totalInclTax: parsed.totalInclTax,
          status: 'NEW',
          lines: {
            create: parsed.lines.map((l) => ({
              lineNo: l.lineNo,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              amountExclTax: l.amountExclTax,
              taxCode: l.taxCode,
              taxRate: l.taxRate,
              taxAmount: l.taxAmount,
              amountInclTax: l.amountInclTax,
            })),
          },
          files: { create: filesCreate },
        },
      });

      enrichInvoiceById(invoice.id).catch(() => {});

      await createAuditLogBestEffort({
        action: 'FETCH_PA',
        entityType: 'INVOICE',
        entityId: invoice.id,
        sapUser,
        outcome: 'OK',
        payloadAfter: { filename: originalName, format: parsed.format, paSource: 'MANUAL_UPLOAD' },
        ...getRequestMeta(request),
      });

      return reply
        .code(201)
        .send({ success: true, data: { invoiceId: invoice.id, created: true } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(422).send({ success: false, error: message });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
}

// ─── Helper PDF_ONLY ──────────────────────────────────────────────────────────

function buildPdfOnly(baseName: string) {
  return {
    format: 'PDF_ONLY' as const,
    direction: 'INVOICE' as const,
    docNumberPa: baseName,
    docDate: new Date().toISOString().split('T')[0],
    dueDate: null,
    currency: 'EUR',
    supplierPaIdentifier: 'UNKNOWN',
    supplierNameRaw: baseName,
    totalExclTax: '0',
    totalTax: '0',
    totalInclTax: '0',
    lines: [] as {
      lineNo: number;
      description: string;
      quantity: string;
      unitPrice: string;
      amountExclTax: string;
      taxRate: string | null;
      taxCode: string | null;
      taxAmount: string;
      amountInclTax: string;
    }[],
  };
}
