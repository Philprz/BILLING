import fs from 'fs';
import { prisma } from '@pa-sap-bridge/database';
import type { Prisma } from '@pa-sap-bridge/database';
import type { ParsedInvoice } from '../parsers/types';
import type { StoredFile } from './file-store';

export interface WriteResult {
  invoiceId: string;
  created: boolean; // false si déjà existant (idempotence)
}

function deleteStoredFile(storedFile: StoredFile): void {
  try {
    fs.unlinkSync(storedFile.absolutePath);
  } catch {
    /* ignore */
  }
}

/**
 * Construit l'objet `data` de création d'une facture à partir du parse.
 * Les `overrides` permettent au flux 384 d'ajuster status / statusReason / replacesInvoiceId
 * sans dupliquer le mapping. Chaque appel produit un objet neuf (nested create inclus).
 */
function buildInvoiceCreateData(
  parsed: ParsedInvoice,
  paMessageId: string,
  paSource: string,
  storedFile: StoredFile,
  kind: 'PDF' | 'XML',
  overrides: Partial<Prisma.InvoiceCreateInput> = {},
): Prisma.InvoiceCreateInput {
  return {
    paMessageId,
    paSource,
    direction: parsed.direction,
    format: parsed.format,
    supplierPaIdentifier: parsed.supplierPaIdentifier,
    supplierNameRaw: parsed.supplierNameRaw,
    supplierExtracted: parsed.supplierExtracted
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
    prepaidAmount: parsed.prepaidAmount ?? null,
    allowanceTotal: parsed.allowanceTotal ?? null,
    chargeTotal: parsed.chargeTotal ?? null,
    correctedInvoiceRef: parsed.correctedInvoiceRef ?? null,
    typeTransaction: parsed.typeTransaction ?? null,
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
    files: {
      create: [
        {
          kind,
          path: storedFile.absolutePath,
          sizeBytes: storedFile.sizeBytes,
          sha256: storedFile.sha256,
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Traite une facture rectificative 384 liée à un litige (BT-25 correctedInvoiceRef présent).
 *
 * Règle métier : une 384 n'existe que comme suite d'une mise en litige. On NE doit PAS lui
 * appliquer le dédoublon métier doc+fournisseur (elle peut réutiliser le n° de l'originale).
 *  - Originale = même fournisseur, docNumberPa == correctedInvoiceRef, status == DISPUTED.
 *  - Trouvée : on supersède l'originale (SUPERSEDED) et on crée le 384 (NEW, replacesInvoiceId).
 *  - Introuvable (ou pas DISPUTED) : on crée le 384 en TO_REVIEW avec un statusReason explicite,
 *    sans supersession (on ne perd jamais la facture).
 *
 * Ordre transactionnel : on supersède l'originale AVANT de créer le 384. Ceci est requis par
 * l'index unique partiel `uq_invoices_doc_supplier_active` (WHERE status <> 'SUPERSEDED') : si le
 * 384 réutilise le n° de l'originale, l'originale doit d'abord sortir de l'index. (Écart assumé
 * vs. l'ordre « créer puis superséder » du brief — résultat fonctionnel identique.)
 */
async function handleCorrectiveInvoice(
  parsed: ParsedInvoice,
  buildData: (overrides?: Partial<Prisma.InvoiceCreateInput>) => Prisma.InvoiceCreateInput,
): Promise<WriteResult> {
  const correctedRef = parsed.correctedInvoiceRef as string;

  const original = await prisma.invoice.findFirst({
    where: {
      supplierPaIdentifier: parsed.supplierPaIdentifier,
      docNumberPa: correctedRef,
      status: 'DISPUTED',
    },
    select: { id: true },
  });

  if (!original) {
    const created = await prisma.invoice.create({
      data: buildData({
        status: 'TO_REVIEW',
        statusReason: `Rectificative 384 sans facture en litige correspondante (réf. ${correctedRef})`,
      }),
    });
    return { invoiceId: created.id, created: true };
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: original.id },
      data: {
        status: 'SUPERSEDED',
        statusReason: `Remplacée par rectificative ${parsed.docNumberPa}`,
      },
    });
    return tx.invoice.create({
      data: buildData({
        status: 'NEW',
        replaces: { connect: { id: original.id } },
      }),
    });
  });

  return { invoiceId: created.id, created: true };
}

/**
 * Insère ou ignore une facture parsée.
 * La clé d'idempotence est paMessageId. Si elle existe déjà, on ne modifie rien.
 */
export async function writeInvoice(
  parsed: ParsedInvoice,
  paMessageId: string,
  paSource: string,
  storedFile: StoredFile,
  originalFilename: string,
): Promise<WriteResult> {
  // Vérification idempotence — par paMessageId (même source + même nom)
  const existing = await prisma.invoice.findUnique({
    where: { paMessageId },
    select: { id: true },
  });
  if (existing) {
    deleteStoredFile(storedFile);
    return { invoiceId: existing.id, created: false };
  }

  // Vérification doublon contenu — même SHA-256 = même fichier, quel que soit le nom ou le canal
  const existingByHash = await prisma.invoiceFile.findFirst({
    where: { sha256: storedFile.sha256 },
    select: { invoiceId: true },
  });
  if (existingByHash) {
    // Supprimer la copie orpheline déjà écrite dans le stockage permanent
    deleteStoredFile(storedFile);
    return { invoiceId: existingByHash.invoiceId, created: false };
  }

  // Déduction du FileKind selon l'extension
  const ext = originalFilename.split('.').pop()?.toLowerCase();
  const kind = ext === 'pdf' ? 'PDF' : 'XML';

  const buildData = (overrides: Partial<Prisma.InvoiceCreateInput> = {}) =>
    buildInvoiceCreateData(parsed, paMessageId, paSource, storedFile, kind, overrides);

  // Cas 384 : rectificative liée à un litige — contourne UNIQUEMENT le dédoublon métier
  // doc+fournisseur ci-dessous (l'idempotence paMessageId et le doublon SHA-256 restent actifs).
  if (parsed.direction === 'CORRECTIVE_INVOICE' && parsed.correctedInvoiceRef) {
    return handleCorrectiveInvoice(parsed, buildData);
  }

  // Vérification doublon métier — même numéro de document + même fournisseur, quel que soit le canal
  const existingByDocNum = await prisma.invoice.findFirst({
    where: {
      docNumberPa: parsed.docNumberPa,
      supplierPaIdentifier: parsed.supplierPaIdentifier,
    },
    select: { id: true },
  });
  if (existingByDocNum) {
    deleteStoredFile(storedFile);
    return { invoiceId: existingByDocNum.id, created: false };
  }

  const invoice = await prisma.invoice.create({ data: buildData() });

  return { invoiceId: invoice.id, created: true };
}
