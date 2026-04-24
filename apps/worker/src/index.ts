import './env';

import os from 'os';
import path from 'path';
import { prisma } from '@pa-sap-bridge/database';
import { POLL_INTERVAL_MS, INBOX_PATH, PROCESSED_PATH } from './config';
import { scanInbox } from './sources/local-folder';
import { fetchSftpFiles } from './sources/sftp.source';
import { runChannelCycle } from './ingestion/channel-runner';
import { runPaStatusJob } from './jobs/pa-status-job';
import { runRuleCleanupJob } from './jobs/rule-cleanup.job';

function log(msg: string): void {
  console.log(`[Worker][${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Nettoyage hebdomadaire ────────────────────────────────────────────────────
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;

async function maybeRunWeeklyCleanup(): Promise<void> {
  if (Date.now() - lastCleanupAt < WEEK_MS) return;
  lastCleanupAt = Date.now();
  await runRuleCleanupJob();
}

// ── Gestion du délai par canal ────────────────────────────────────────────────
// On mémorise la prochaine échéance de polling pour chaque canal (par id).
const nextPollAt = new Map<string, number>();

function isDue(channelId: string, _intervalSeconds: number): boolean {
  const due = nextPollAt.get(channelId) ?? 0;
  return Date.now() >= due;
}

function schedulNext(channelId: string, intervalSeconds: number): void {
  nextPollAt.set(channelId, Date.now() + intervalSeconds * 1000);
}

// ── Canal LOCAL_DEV (toujours présent si inbox non vide) ─────────────────────

const LOCAL_CHANNEL_ID = '__local__';
const LOCAL_CHANNEL_NAME = 'LOCAL_DEV';

async function pollLocalChannel(): Promise<void> {
  const files = scanInbox();
  await runChannelCycle(LOCAL_CHANNEL_ID, LOCAL_CHANNEL_NAME, 'LOCAL_DEV', files, PROCESSED_PATH);
}

// ── Canaux DB (SFTP / API) ───────────────────────────────────────────────────

async function pollDbChannels(): Promise<void> {
  const channels = await prisma.paChannel.findMany({ where: { active: true } });

  for (const ch of channels) {
    if (!isDue(ch.id, ch.pollIntervalSeconds)) continue;

    log(`Polling canal "${ch.name}" (${ch.protocol})…`);
    schedulNext(ch.id, ch.pollIntervalSeconds);

    try {
      if (ch.protocol === 'SFTP') {
        if (!ch.host || !ch.user || !ch.passwordEncrypted || !ch.remotePathIn) {
          log(`Canal "${ch.name}" ignoré : configuration SFTP incomplète.`);
          await prisma.paChannel.update({
            where: { id: ch.id },
            data: {
              lastPollAt: new Date(),
              lastPollError:
                'Configuration SFTP incomplète (host/user/password/remotePathIn requis)',
            },
          });
          continue;
        }

        const tmpDir = path.join(os.tmpdir(), 'pa-sap-bridge', ch.id);
        const files = await fetchSftpFiles({
          host: ch.host,
          port: ch.port ?? 22,
          user: ch.user,
          password: ch.passwordEncrypted,
          remotePathIn: ch.remotePathIn,
          remotePathProcessed: ch.remotePathProcessed,
          localTmpDir: tmpDir,
        });

        await runChannelCycle(ch.id, ch.name, `SFTP:${ch.name}`, files);
      } else {
        // Protocole API — stub : enregistre le cycle sans fichiers
        // (l'implémentation API sera ajoutée dans un lot ultérieur)
        log(`Canal API "${ch.name}" : polling API non encore implémenté.`);
        await prisma.paChannel.update({
          where: { id: ch.id },
          data: { lastPollAt: new Date(), lastPollError: null },
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Erreur sur le canal "${ch.name}" : ${message}`);
      await prisma.paChannel
        .update({
          where: { id: ch.id },
          data: { lastPollAt: new Date(), lastPollError: message },
        })
        .catch(() => {});
    }
  }
}

// ── Boucle principale ─────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  await pollLocalChannel();
  await pollDbChannels();
  await runPaStatusJob();
  await maybeRunWeeklyCleanup();
}

async function main(): Promise<void> {
  log(`Worker PA-SAP-Bridge démarré (intervalle de base : ${POLL_INTERVAL_MS}ms).`);
  log(`Canal LOCAL_DEV actif — inbox : ${INBOX_PATH}`);
  log(`Formats supportés : UBL 2.1 (.xml) | PDF sans données (.pdf)`);

  let running = true;
  process.on('SIGINT', () => {
    log('Arrêt demandé (SIGINT).');
    running = false;
  });
  process.on('SIGTERM', () => {
    log('Arrêt demandé (SIGTERM).');
    running = false;
  });

  while (running) {
    try {
      await runCycle();
    } catch (err) {
      log(`Erreur non fatale dans le cycle : ${String(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log('Worker arrêté proprement.');
}

main();
