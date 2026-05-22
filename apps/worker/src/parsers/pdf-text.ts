/**
 * Extraction du texte natif d'un PDF (couche texte uniquement, pas d'OCR).
 *
 * - Si la couche texte est suffisante (> 50 caractères non blancs), on l'utilise.
 * - Sinon, hasTextLayer = false → l'appelant doit décider d'un fallback (OCR
 *   futur, ou conserver l'invoice en PDF_ONLY pour intervention humaine).
 *
 * On utilise `pdf-parse` (CommonJS, stable) via son chemin de lib pour éviter
 * la lecture du fichier de test au chargement du module.
 */

import fs from 'fs';
import pdfParse from 'pdf-parse';

export interface PdfExtraction {
  rawText: string;
  numPages: number;
  hasTextLayer: boolean;
}

export async function extractPdfText(absolutePath: string): Promise<PdfExtraction> {
  const buffer = fs.readFileSync(absolutePath);
  // La version pdfjs par défaut (v1.10.100) embarquée par pdf-parse a un bug
  // sur l'analyse XRef de certains PDF 1.3 ("bad XRef entry"). v1.10.88
  // accepte ces fichiers (testé sur les PDF générés en interne).
  const result = await pdfParse(buffer, { version: 'v1.10.88' });
  const rawText = (result.text ?? '').replace(/\r\n/g, '\n');
  const hasTextLayer = rawText.replace(/\s/g, '').length > 50;
  return {
    rawText,
    numPages: result.numpages ?? 0,
    hasTextLayer,
  };
}
