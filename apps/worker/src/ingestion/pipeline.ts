import fs from 'fs';
import path from 'path';
import { scanInbox } from '../sources/local-folder';
import { parseFile } from '../parsers/index';
import { storeFile } from './file-store';
import { writeInvoice } from './db-writer';
import { auditIngestion } from '../audit';
import { enrichInvoice } from '../matching/enricher';
import { PROCESSED_PATH, ERROR_PATH, PA_SOURCE_LOCAL } from '../config';

function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  console.log(`[Worker][${new Date().toISOString()}][${level}] ${msg}`);
}

function moveFile(src: string, destDir: string, filename: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(src, path.join(destDir, filename));
}

/**
 * Un cycle d'ingestion :
 * 1. Scanne l'inbox
 * 2. Pour chaque fichier : parse → stocke → écrit en DB
 * 3. Déplace vers processed/ ou error/
 * 4. Journalise dans audit_log
 */
export async function runIngestionCycle(): Promise<void> {
  const files = scanInbox();

  if (files.length === 0) {
    log('INFO', 'Inbox vide — rien à traiter.');
    return;
  }

  log('INFO', `${files.length} fichier(s) trouvé(s) dans l'inbox.`);

  for (const file of files) {
    const paMessageId = `LOCAL:${file.filename}`;

    try {
      // 1. Parsing
      const parsed = parseFile(file.absolutePath, file.ext);
      log('INFO', `[${file.filename}] Format détecté : ${parsed.format} — Doc : ${parsed.docNumberPa}`);

      // 2. Stockage permanent (avant écriture DB pour avoir le chemin)
      //    On utilise un UUID temporaire si l'invoice n'existe pas encore ;
      //    le vrai UUID sera généré par Prisma. On stocke d'abord, puis DB.
      //    Le nom final inclura l'ID de la facture — mais pour simplifier
      //    on utilise le paMessageId comme préfixe de fichier.
      const tempId  = paMessageId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const stored  = storeFile(file.absolutePath, tempId, file.filename);
      log('INFO', `[${file.filename}] Fichier stocké : ${stored.absolutePath} (${stored.sha256.slice(0, 12)}…)`);

      // 3. Écriture DB
      const result = await writeInvoice(
        parsed,
        paMessageId,
        PA_SOURCE_LOCAL,
        stored,
        file.filename,
      );

      if (!result.created) {
        log('INFO', `[${file.filename}] Déjà ingéré (idempotent) — invoiceId: ${result.invoiceId}`);
      } else {
        log('INFO', `[${file.filename}] ✓ Facture créée — invoiceId: ${result.invoiceId}`);
      }

      // 4. Enrichissement (matching fournisseur + suggestions comptes)
      try {
        await enrichInvoice(result.invoiceId);
        log('INFO', `[${file.filename}] Enrichissement OK`);
      } catch (enrichErr) {
        log('WARN', `[${file.filename}] Enrichissement échoué (non bloquant): ${String(enrichErr)}`);
      }

      // 5. Audit
      await auditIngestion('OK', result.invoiceId, {
        filename:    file.filename,
        format:      parsed.format,
        docNumberPa: parsed.docNumberPa,
        created:     result.created,
      });

      // 6. Déplacement vers processed/
      moveFile(file.absolutePath, PROCESSED_PATH, file.filename);

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log('ERROR', `[${file.filename}] Échec d'ingestion : ${message}`);

      await auditIngestion('ERROR', null, { filename: file.filename, error: message });

      // Déplacement vers error/
      try {
        moveFile(file.absolutePath, ERROR_PATH, file.filename);
      } catch {
        log('WARN', `[${file.filename}] Impossible de déplacer vers error/ — fichier laissé dans inbox.`);
      }
    }
  }
}
