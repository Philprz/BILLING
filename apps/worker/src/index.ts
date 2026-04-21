import './env';

import { POLL_INTERVAL_MS } from './config';
import { runIngestionCycle } from './ingestion/pipeline';
import { runPaStatusJob } from './jobs/pa-status-job';

function log(msg: string): void {
  console.log(`[Worker][${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle(): Promise<void> {
  await runIngestionCycle();
  await runPaStatusJob();
  await sleep(POLL_INTERVAL_MS);
}

async function main(): Promise<void> {
  log(`Worker PA-SAP-Bridge démarré (intervalle : ${POLL_INTERVAL_MS}ms).`);
  log(`Sources supportées : LOCAL_DEV (dossier data/inbox/)`);
  log(`Formats supportés : UBL 2.1 (.xml)  |  PDF sans données (.pdf)`);
  log(`Formats préparés (non supportés) : CII (.xml avec namespace CII)`);

  let running = true;
  process.on('SIGINT',  () => { log('Arrêt demandé (SIGINT).');  running = false; });
  process.on('SIGTERM', () => { log('Arrêt demandé (SIGTERM).'); running = false; });

  while (running) {
    try {
      await runCycle();
    } catch (err) {
      log(`Erreur non fatale dans le cycle : ${String(err)}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  log('Worker arrêté proprement.');
}

main();
