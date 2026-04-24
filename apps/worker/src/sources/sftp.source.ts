import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import type { InboxFile } from './types';

export interface SftpChannelConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  remotePathIn: string;
  remotePathProcessed: string | null;
  localTmpDir: string;
}

const SUPPORTED_EXTENSIONS = new Set(['.xml', '.pdf']);

/**
 * Liste les fichiers disponibles dans `remotePathIn` puis les télécharge
 * dans `localTmpDir`. Retourne des InboxFile pointant vers les copies locales.
 *
 * Les fichiers sont déplacés vers `remotePathProcessed` (si défini) une fois
 * téléchargés pour garantir l'idempotence au niveau du canal.
 */
export async function fetchSftpFiles(config: SftpChannelConfig): Promise<InboxFile[]> {
  const sftp = new SftpClient();
  const result: InboxFile[] = [];

  try {
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.user,
      password: config.password,
    });

    const listing = await sftp.list(config.remotePathIn);
    const files = listing.filter(
      (f) => f.type === '-' && SUPPORTED_EXTENSIONS.has(path.extname(f.name).toLowerCase()),
    );

    if (files.length === 0) return [];

    const fs = await import('fs');
    fs.mkdirSync(config.localTmpDir, { recursive: true });

    for (const f of files) {
      const remoteSrc = `${config.remotePathIn}/${f.name}`;
      const localDest = path.join(config.localTmpDir, f.name);

      await sftp.fastGet(remoteSrc, localDest);

      result.push({
        filename: f.name,
        absolutePath: localDest,
        ext: path.extname(f.name).toLowerCase(),
      });

      if (config.remotePathProcessed) {
        const remoteDest = `${config.remotePathProcessed}/${f.name}`;
        try {
          await sftp.rename(remoteSrc, remoteDest);
        } catch {
          // Si le dossier processed n'existe pas, tenter de supprimer à la place
          try {
            await sftp.delete(remoteSrc);
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          await sftp.delete(remoteSrc);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    await sftp.end().catch(() => {});
  }

  return result;
}
