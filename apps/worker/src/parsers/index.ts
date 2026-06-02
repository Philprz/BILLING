/**
 * Dispatcher de parseurs : détecte le format d'un fichier XML et appelle
 * le parseur approprié.
 *
 * Formats supportés :
 *   UBL 2.1    → parseUbl()    ✅ implémenté
 *   CII D16B   → parseCii()    🚧 stub (détecté, rejeté explicitement)
 *   Factur-X   → combinaison PDF+CII, non géré ici (traité comme PDF_ONLY)
 *   PDF seul   → extraction de la couche texte + heuristiques regex
 *                (Niveau 2 du plan d'extraction — pas d'OCR)
 */

import fs from 'fs';
import { parseUbl } from './ubl.parser';
import { parseCii } from './cii.parser';
import { extractPdfText } from './pdf-text';
import { extractInvoiceFields } from './pdf-fields';
import { extractInvoiceLines } from './pdf-lines';
import type { ParsedInvoice } from './types';

// Détection du format par namespace XML (lecture légère des 2048 premiers octets)
const NS_UBL_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_UBL_CN = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';
const NS_CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';

function detectXmlFormat(header: string): 'UBL' | 'CII' | 'UNKNOWN' {
  if (header.includes(NS_UBL_INVOICE) || header.includes(NS_UBL_CN)) return 'UBL';
  if (header.includes(NS_CII)) return 'CII';
  return 'UNKNOWN';
}

function log(level: 'INFO' | 'WARN', msg: string): void {
  console.log(`[Parser][${new Date().toISOString()}][${level}] ${msg}`);
}

async function parsePdf(absolutePath: string): Promise<ParsedInvoice> {
  const filename = absolutePath.split(/[\\/]/).pop() ?? 'UNKNOWN.pdf';
  const fallbackDocNum = filename.replace(/\.pdf$/i, '');

  let extraction;
  try {
    extraction = await extractPdfText(absolutePath);
  } catch (err) {
    log('WARN', `[${filename}] Extraction texte PDF échouée — fallback minimal. ${String(err)}`);
    return {
      format: 'PDF_ONLY',
      direction: 'INVOICE',
      docNumberPa: fallbackDocNum,
      docDate: new Date().toISOString().split('T')[0],
      dueDate: null,
      currency: 'EUR',
      supplierPaIdentifier: 'UNKNOWN',
      supplierNameRaw: '',
      totalExclTax: '0',
      totalTax: '0',
      totalInclTax: '0',
      prepaidAmount: null,
      allowanceTotal: null,
      chargeTotal: null,
      correctedInvoiceRef: null,
      lines: [],
      supplierExtracted: null,
    };
  }

  log(
    'INFO',
    `[${filename}] pdf.pages=${extraction.numPages} hasTextLayer=${extraction.hasTextLayer} textLength=${extraction.rawText.length}`,
  );

  if (!extraction.hasTextLayer) {
    // PDF scanné/image — pas d'OCR à ce niveau. On reste en PDF_ONLY pour
    // intervention humaine ; on NE pollue PAS supplierNameRaw avec le nom
    // du fichier (Niveau 1).
    return {
      format: 'PDF_ONLY',
      direction: 'INVOICE',
      docNumberPa: fallbackDocNum,
      docDate: new Date().toISOString().split('T')[0],
      dueDate: null,
      currency: 'EUR',
      supplierPaIdentifier: 'UNKNOWN',
      supplierNameRaw: '',
      totalExclTax: '0',
      totalTax: '0',
      totalInclTax: '0',
      prepaidAmount: null,
      allowanceTotal: null,
      chargeTotal: null,
      correctedInvoiceRef: null,
      lines: [],
      supplierExtracted: null,
    };
  }

  const fields = extractInvoiceFields(extraction.rawText);
  const linesResult = extractInvoiceLines(extraction.rawText);

  // Validation forme identifiant fournisseur : SIRET 14 chiffres, SIREN 9
  // chiffres, ou n° TVA FR (FR + 11 chiffres). Hors de ces formats, le
  // matching côté SAP B1 sera dégradé — on le signale plutôt que de laisser
  // l'opérateur deviner pourquoi le score plafonne à 85 %.
  if (fields.supplierPaIdentifier) {
    const id = fields.supplierPaIdentifier;
    const validShape =
      /^\d{14}$/.test(id) || /^\d{9}$/.test(id) || /^FR\d{11}$/i.test(id.replace(/\s/g, ''));
    if (!validShape) {
      log(
        'WARN',
        `[${filename}] pdf.supplier.idFormat invalide "${id}" — ni SIRET 14, ni SIREN 9, ni TVA FR+11 ; matching SAP dégradé`,
      );
    }
  } else {
    log(
      'WARN',
      `[${filename}] pdf.supplier.idAbsent — aucun identifiant fiscal extrait du bloc FOURNISSEUR (matching par nom uniquement)`,
    );
  }

  // Validation croisée : si la somme des HT s'écarte du total déclaré de plus
  // de 1 % (et au moins 0.05 €), on rejette les lignes — préférable à des
  // lignes incohérentes qui empêcheraient l'auto-post SAP.
  const declaredHT = parseFloat(fields.totalExclTax);
  let lines = linesResult.lines;
  let linesConfidence = linesResult.confidence;
  if (lines.length > 0 && declaredHT > 0) {
    const diff = Math.abs(linesResult.sumExclTax - declaredHT);
    const tolerance = Math.max(0.05, declaredHT * 0.01);
    if (diff > tolerance) {
      log(
        'WARN',
        `[${filename}] pdf.lines.mismatch sumHT=${linesResult.sumExclTax.toFixed(2)} declaredHT=${declaredHT.toFixed(2)} — lignes rejetées`,
      );
      lines = [];
      linesConfidence = 0;
    }
  }

  log(
    'INFO',
    `[${filename}] pdf.extracted supplier="${fields.supplierNameRaw}" id="${fields.supplierPaIdentifier}" conf=${fields.confidence.supplier} doc="${fields.documentNumber}" date=${fields.documentDate} ttc=${fields.totalInclTax} lines=${lines.length} sumHT=${linesResult.sumExclTax.toFixed(2)} linesConf=${linesConfidence}`,
  );

  // Aucun fournisseur fiable ET aucun n° de doc : on retombe sur le nom de
  // fichier pour le docNumber (idempotence), mais supplierNameRaw reste vide.
  const docNumberPa = fields.documentNumber || fallbackDocNum;
  const supplierPaIdentifier = fields.supplierPaIdentifier || 'UNKNOWN';

  return {
    format: 'PDF_ONLY',
    direction: 'INVOICE',
    docNumberPa,
    docDate: fields.documentDate ?? new Date().toISOString().split('T')[0],
    dueDate: fields.dueDate,
    currency: fields.currency,
    supplierPaIdentifier,
    supplierNameRaw: fields.supplierNameRaw,
    totalExclTax: fields.totalExclTax,
    totalTax: fields.totalTax,
    totalInclTax: fields.totalInclTax,
    prepaidAmount: null,
    allowanceTotal: null,
    chargeTotal: null,
    correctedInvoiceRef: null,
    lines,
    supplierExtracted: null,
  };
}

export async function parseFile(absolutePath: string, ext: string): Promise<ParsedInvoice> {
  if (ext === '.pdf') {
    return parsePdf(absolutePath);
  }

  if (ext !== '.xml') {
    throw new Error(`Extension non supportée : ${ext}`);
  }

  const xmlContent = fs.readFileSync(absolutePath, 'utf-8');
  // Lecture des 2 Ko suffisante pour les déclarations de namespace
  const header = xmlContent.slice(0, 2048);
  const format = detectXmlFormat(header);

  if (format === 'UBL') return parseUbl(xmlContent);
  if (format === 'CII') return parseCii(xmlContent); // lève une erreur explicite

  throw new Error(
    'Format XML non reconnu : namespace inconnu dans le document. ' +
      'Formats XML supportés : UBL 2.1, CII D16B.',
  );
}
