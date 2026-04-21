import { prisma } from '@pa-sap-bridge/database';
import type { ParsedInvoice } from '../parsers/types';
import type { StoredFile } from './file-store';

export interface WriteResult {
  invoiceId:  string;
  created:    boolean;  // false si déjà existant (idempotence)
}

/**
 * Insère ou ignore une facture parsée.
 * La clé d'idempotence est paMessageId. Si elle existe déjà, on ne modifie rien.
 */
export async function writeInvoice(
  parsed:      ParsedInvoice,
  paMessageId: string,
  paSource:    string,
  storedFile:  StoredFile,
  originalFilename: string,
): Promise<WriteResult> {

  // Vérification idempotence
  const existing = await prisma.invoice.findUnique({
    where: { paMessageId },
    select: { id: true },
  });
  if (existing) {
    return { invoiceId: existing.id, created: false };
  }

  // Déduction du FileKind selon l'extension
  const ext = originalFilename.split('.').pop()?.toLowerCase();
  const kind = ext === 'pdf' ? 'PDF' : 'XML';

  const invoice = await prisma.invoice.create({
    data: {
      paMessageId,
      paSource,
      direction:             parsed.direction,
      format:                parsed.format,
      supplierPaIdentifier:  parsed.supplierPaIdentifier,
      supplierNameRaw:       parsed.supplierNameRaw,
      supplierMatchConfidence: 0,
      docNumberPa:           parsed.docNumberPa,
      docDate:               new Date(parsed.docDate),
      dueDate:               parsed.dueDate ? new Date(parsed.dueDate) : null,
      currency:              parsed.currency,
      totalExclTax:          parsed.totalExclTax,
      totalTax:              parsed.totalTax,
      totalInclTax:          parsed.totalInclTax,
      status:                'NEW',
      lines: {
        create: parsed.lines.map((l) => ({
          lineNo:        l.lineNo,
          description:   l.description,
          quantity:      l.quantity,
          unitPrice:     l.unitPrice,
          amountExclTax: l.amountExclTax,
          taxCode:       l.taxCode,
          taxRate:       l.taxRate,
          taxAmount:     l.taxAmount,
          amountInclTax: l.amountInclTax,
        })),
      },
      files: {
        create: [{
          kind,
          path:      storedFile.absolutePath,
          sizeBytes: storedFile.sizeBytes,
          sha256:    storedFile.sha256,
        }],
      },
    },
  });

  return { invoiceId: invoice.id, created: true };
}
