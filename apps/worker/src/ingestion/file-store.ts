import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { INVOICES_PATH } from '../config';

export interface StoredFile {
  absolutePath: string;
  sizeBytes:    bigint;
  sha256:       string;
}

/**
 * Copie un fichier de l'inbox vers le stockage permanent et calcule son SHA-256.
 * Chemin destination : {INVOICES_PATH}/{yearMonth}/{invoiceId}-{filename}
 */
export function storeFile(
  sourcePath: string,
  invoiceId:  string,
  filename:   string,
): StoredFile {
  const yearMonth = new Date().toISOString().slice(0, 7);  // ex. "2026-04"
  const destDir   = path.join(INVOICES_PATH, yearMonth);

  fs.mkdirSync(destDir, { recursive: true });

  const destFilename = `${invoiceId}-${filename}`;
  const destPath     = path.join(destDir, destFilename);

  fs.copyFileSync(sourcePath, destPath);

  const content   = fs.readFileSync(destPath);
  const sha256    = crypto.createHash('sha256').update(content).digest('hex');
  const sizeBytes = BigInt(content.byteLength);

  return { absolutePath: destPath, sizeBytes, sha256 };
}
