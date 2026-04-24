/**
 * POST /api/invoices/upload
 * Import manuel d'une facture XML (UBL / CII) ou PDF via multipart/form-data.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { requireSession } from '../middleware/require-session';
import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import { enrichInvoiceById } from '../services/enrichment.service';

const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH
  ? path.resolve(process.env.FILE_STORAGE_PATH)
  : path.join(process.cwd(), 'data');
const INVOICES_PATH = path.join(FILE_STORAGE_PATH, 'invoices');
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const NS_UBL_INV = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_UBL_CN = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';
const NS_CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';

interface ParsedFields {
  format: 'UBL' | 'CII' | 'PDF_ONLY';
  direction: 'INVOICE' | 'CREDIT_NOTE';
  docNumberPa: string;
  docDate: string;
  dueDate: string | null;
  currency: string;
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  totalExclTax: string;
  totalTax: string;
  totalInclTax: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function text(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in (node as Record<string, unknown>))
    return String((node as Record<string, unknown>)['#text']).trim();
  return '';
}

function num(node: unknown): string {
  const s = text(node);
  return s || '0';
}

function ciiDate(raw: string): string {
  const s = raw.replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : raw.trim();
}

function parseXml(content: string, filename: string): ParsedFields {
  const header = content.slice(0, 2048);
  const isUbl = header.includes(NS_UBL_INV) || header.includes(NS_UBL_CN);
  const isCii = header.includes(NS_CII);

  if (!isUbl && !isCii) {
    throw new Error('Format XML non reconnu. Formats supportés : UBL 2.1, CII D16B.');
  }

  const doc = xmlParser.parse(content) as Record<string, unknown>;

  if (isUbl) {
    const root = (doc['Invoice'] ?? doc['CreditNote']) as Record<string, unknown>;
    if (!root) throw new Error('Élément racine Invoice/CreditNote absent');

    const isCn = 'CreditNote' in doc;
    const typeCode = text(root['cbc:InvoiceTypeCode'] ?? root['cbc:CreditNoteTypeCode']);
    const direction: ParsedFields['direction'] =
      isCn || typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';

    const supplier =
      ((root['cac:AccountingSupplierParty'] as Record<string, unknown>)?.['cac:Party'] as Record<
        string,
        unknown
      >) ?? {};
    const taxSchemes = supplier['cac:PartyTaxScheme'];
    const firstTax = Array.isArray(taxSchemes) ? taxSchemes[0] : taxSchemes;

    const monetary = (root['cac:LegalMonetaryTotal'] ?? {}) as Record<string, unknown>;
    const taxTotal = (root['cac:TaxTotal'] ?? {}) as Record<string, unknown>;

    return {
      format: 'UBL',
      direction,
      docNumberPa: text(root['cbc:ID']) || filename,
      docDate: text(root['cbc:IssueDate']) || new Date().toISOString().split('T')[0],
      dueDate: text(root['cbc:DueDate']) || null,
      currency: text(root['cbc:DocumentCurrencyCode']) || 'EUR',
      supplierPaIdentifier:
        text((firstTax as Record<string, unknown>)?.['cbc:CompanyID']) || 'UNKNOWN',
      supplierNameRaw:
        text((supplier['cac:PartyName'] as Record<string, unknown>)?.['cbc:Name']) || filename,
      totalExclTax: num(monetary['cbc:TaxExclusiveAmount']),
      totalTax: num(taxTotal?.['cbc:TaxAmount']),
      totalInclTax: num(monetary['cbc:TaxInclusiveAmount'] ?? monetary['cbc:PayableAmount']),
    };
  }

  // CII
  const root = (doc['rsm:CrossIndustryInvoice'] ?? doc['CrossIndustryInvoice']) as Record<
    string,
    unknown
  >;
  if (!root) throw new Error('Élément racine CrossIndustryInvoice absent');

  const header2 = (root['rsm:ExchangedDocument'] as Record<string, unknown>) ?? {};
  const typeCode = text(header2['ram:TypeCode']);
  const direction: ParsedFields['direction'] =
    typeCode === '381' || typeCode === '389' ? 'CREDIT_NOTE' : 'INVOICE';
  const dtNode = (header2['ram:IssueDateTime'] ?? {}) as Record<string, unknown>;
  const rawDate = text(dtNode['udt:DateTimeString'] ?? dtNode['DateTimeString'] ?? dtNode);

  const trx = (root['rsm:SupplyChainTradeTransaction'] ?? {}) as Record<string, unknown>;
  const agreement = (trx['ram:ApplicableHeaderTradeAgreement'] ?? {}) as Record<string, unknown>;
  const seller = (agreement['ram:SellerTradeParty'] ?? {}) as Record<string, unknown>;
  const settlement = (trx['ram:ApplicableHeaderTradeSettlement'] ?? {}) as Record<string, unknown>;
  const sums = (settlement['ram:SpecifiedTradeSettlementHeaderMonetarySummation'] ?? {}) as Record<
    string,
    unknown
  >;
  const taxRegs = seller['ram:SpecifiedTaxRegistration'];
  const firstTaxReg = Array.isArray(taxRegs) ? taxRegs[0] : taxRegs;

  return {
    format: 'CII',
    direction,
    docNumberPa: text(header2['ram:ID']) || filename,
    docDate: rawDate ? ciiDate(rawDate) : new Date().toISOString().split('T')[0],
    dueDate: null,
    currency: text(settlement['ram:InvoiceCurrencyCode']) || 'EUR',
    supplierPaIdentifier: text((firstTaxReg as Record<string, unknown>)?.['ram:ID']) || 'UNKNOWN',
    supplierNameRaw: text(seller['ram:Name']) || filename,
    totalExclTax: num(sums['ram:TaxBasisTotalAmount']),
    totalTax: num(sums['ram:TaxTotalAmount']),
    totalInclTax: num(sums['ram:GrandTotalAmount']),
  };
}

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

  app.post('/api/invoices/upload', { preHandler: requireSession }, async (request, reply) => {
    const { sapUser } = request.sapSession!;
    const data = await request.file();

    if (!data) return reply.code(400).send({ success: false, error: 'Aucun fichier reçu.' });

    const originalName = data.filename;
    const ext = path.extname(originalName).toLowerCase();
    if (ext !== '.xml' && ext !== '.pdf') {
      await data.toBuffer();
      return reply
        .code(400)
        .send({
          success: false,
          error: `Extension non supportée : ${ext}. Formats acceptés : .xml, .pdf`,
        });
    }

    const buf = await data.toBuffer();
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const tmpPath = path.join(os.tmpdir(), `pa-upload-${sha256.slice(0, 12)}${ext}`);
    fs.writeFileSync(tmpPath, buf);

    try {
      // Parse
      let parsed: ParsedFields;
      if (ext === '.pdf') {
        const docNum = originalName.replace(/\.[^.]+$/, '');
        parsed = {
          format: 'PDF_ONLY',
          direction: 'INVOICE',
          docNumberPa: docNum,
          docDate: new Date().toISOString().split('T')[0],
          dueDate: null,
          currency: 'EUR',
          supplierPaIdentifier: 'UNKNOWN',
          supplierNameRaw: docNum,
          totalExclTax: '0',
          totalTax: '0',
          totalInclTax: '0',
        };
      } else {
        parsed = parseXml(buf.toString('utf-8'), originalName.replace(/\.[^.]+$/, ''));
      }

      // Stockage permanent
      const yearMonth = new Date().toISOString().slice(0, 7);
      const destDir = path.join(INVOICES_PATH, yearMonth);
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, `MANUAL-${Date.now()}-${originalName}`);
      fs.copyFileSync(tmpPath, destPath);
      const sizeBytes = BigInt(buf.byteLength);
      const kind = ext === '.pdf' ? 'PDF' : 'XML';

      const paMessageId = `MANUAL:${sha256.slice(0, 16)}`;

      // Idempotence par paMessageId (hash contenu)
      const existing = await prisma.invoice.findUnique({
        where: { paMessageId },
        select: { id: true },
      });
      if (existing) {
        return reply.send({ success: true, data: { invoiceId: existing.id, created: false } });
      }

      const invoice = await prisma.invoice.create({
        data: {
          paMessageId,
          paSource: 'MANUAL_UPLOAD',
          direction: parsed.direction,
          format: parsed.format as never,
          supplierPaIdentifier: parsed.supplierPaIdentifier,
          supplierNameRaw: parsed.supplierNameRaw,
          supplierMatchConfidence: 0,
          docNumberPa: parsed.docNumberPa,
          docDate: new Date(parsed.docDate),
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
          currency: parsed.currency,
          totalExclTax: parsed.totalExclTax,
          totalTax: parsed.totalTax,
          totalInclTax: parsed.totalInclTax,
          status: 'NEW',
          files: { create: [{ kind, path: destPath, sizeBytes, sha256 }] },
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
