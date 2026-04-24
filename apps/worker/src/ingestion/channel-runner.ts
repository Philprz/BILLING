/**
 * Exécute un cycle d'ingestion pour un canal PA donné (SFTP ou LOCAL).
 * Partagé entre le dispatcher multi-canal (index.ts) et le pipeline local (pipeline.ts).
 */

import fs from 'fs';
import path from 'path';
import { prisma } from '@pa-sap-bridge/database';
import { parseFile } from '../parsers/index';
import { storeFile } from './file-store';
import { writeInvoice } from './db-writer';
import { auditIngestion } from '../audit';
import { enrichInvoice } from '../matching/enricher';
import { ERROR_PATH } from '../config';
import type { InboxFile } from '../sources/types';

function log(level: 'INFO' | 'WARN' | 'ERROR', channelName: string, msg: string): void {
  console.log(`[Worker][${new Date().toISOString()}][${level}][${channelName}] ${msg}`);
}

function moveFile(src: string, destDir: string, filename: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(src, path.join(destDir, filename));
}

/**
 * Traite une liste de fichiers inbox pour un canal donné.
 * Met à jour lastPollAt + lastPollError sur le canal après le cycle.
 */
export async function runChannelCycle(
  channelId: string,
  channelName: string,
  paSource: string,
  files: InboxFile[],
  processedDir?: string,
): Promise<void> {
  let pollError: string | null = null;

  if (files.length === 0) {
    log('INFO', channelName, 'Aucun fichier à traiter.');
  } else {
    log('INFO', channelName, `${files.length} fichier(s) trouvé(s).`);
  }

  for (const file of files) {
    const paMessageId = `${paSource}:${file.filename}`;

    try {
      const parsed = parseFile(file.absolutePath, file.ext);
      log(
        'INFO',
        channelName,
        `[${file.filename}] Format : ${parsed.format} — Doc : ${parsed.docNumberPa}`,
      );

      const tempId = paMessageId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const stored = storeFile(file.absolutePath, tempId, file.filename);

      const result = await writeInvoice(parsed, paMessageId, paSource, stored, file.filename);

      if (!result.created) {
        log(
          'INFO',
          channelName,
          `[${file.filename}] Déjà ingéré (idempotent) — ${result.invoiceId}`,
        );
      } else {
        log('INFO', channelName, `[${file.filename}] ✓ Créée — invoiceId: ${result.invoiceId}`);
      }

      try {
        await enrichInvoice(result.invoiceId);
        log('INFO', channelName, `[${file.filename}] Enrichissement OK`);
      } catch (enrichErr) {
        log('WARN', channelName, `[${file.filename}] Enrichissement échoué : ${String(enrichErr)}`);
      }

      await auditIngestion('OK', result.invoiceId, {
        filename: file.filename,
        format: parsed.format,
        docNumberPa: parsed.docNumberPa,
        created: result.created,
        channelName,
      });

      // Déplace / supprime la copie locale temporaire SFTP si nécessaire
      if (processedDir) {
        try {
          moveFile(file.absolutePath, processedDir, file.filename);
        } catch {
          /* ignore */
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log('ERROR', channelName, `[${file.filename}] Échec : ${message}`);
      pollError = message;

      await auditIngestion('ERROR', null, { filename: file.filename, error: message, channelName });

      try {
        moveFile(file.absolutePath, ERROR_PATH, file.filename);
      } catch {
        log('WARN', channelName, `[${file.filename}] Impossible de déplacer vers error/.`);
      }
    }
  }

  // Met à jour le statut du canal dans la DB
  await prisma.paChannel
    .update({
      where: { id: channelId },
      data: {
        lastPollAt: new Date(),
        lastPollError: pollError,
      },
    })
    .catch((err) =>
      log('WARN', channelName, `Impossible de mettre à jour lastPollAt : ${String(err)}`),
    );
}
