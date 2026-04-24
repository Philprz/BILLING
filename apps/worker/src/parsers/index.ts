/**
 * Dispatcher de parseurs : détecte le format d'un fichier XML et appelle
 * le parseur approprié.
 *
 * Formats supportés :
 *   UBL 2.1    → parseUbl()    ✅ implémenté
 *   CII D16B   → parseCii()    🚧 stub (détecté, rejeté explicitement)
 *   Factur-X   → combinaison PDF+CII, non géré ici (traité comme PDF_ONLY)
 *   PDF seul   → retour minimal sans lignes
 */

import fs from 'fs';
import { parseUbl } from './ubl.parser';
import { parseCii } from './cii.parser';
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

export function parseFile(absolutePath: string, ext: string): ParsedInvoice {
  if (ext === '.pdf') {
    // PDF seul : on crée une entrée minimale sans lignes structurées.
    // Le nom du fichier devient le numéro de document provisoire.
    const filename = absolutePath.split(/[\\/]/).pop() ?? 'UNKNOWN.pdf';
    const docNum = filename.replace(/\.pdf$/i, '');
    return {
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
      lines: [],
    };
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
