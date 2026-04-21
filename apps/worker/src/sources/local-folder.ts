import fs from 'fs';
import path from 'path';
import { INBOX_PATH } from '../config';
import type { InboxFile } from './types';

const SUPPORTED_EXTENSIONS = new Set(['.xml', '.pdf']);

/**
 * Liste les fichiers présents dans le dossier inbox.
 * N'explore pas les sous-dossiers.
 */
export function scanInbox(): InboxFile[] {
  if (!fs.existsSync(INBOX_PATH)) {
    fs.mkdirSync(INBOX_PATH, { recursive: true });
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(INBOX_PATH, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Impossible de lire le dossier inbox (${INBOX_PATH}): ${String(err)}`);
  }

  return entries
    .filter((e) => e.isFile())
    .map((e) => ({
      filename:     e.name,
      absolutePath: path.join(INBOX_PATH, e.name),
      ext:          path.extname(e.name).toLowerCase(),
    }))
    .filter((f) => SUPPORTED_EXTENSIONS.has(f.ext));
}
