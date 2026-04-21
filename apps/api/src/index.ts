import './env';
import { purgeExpiredSessions } from './session/store';
import { buildApp } from './app';

const PORT = Number(process.env.API_PORT) || 3001;
const HOST = process.env.APP_HOST || '0.0.0.0';
const app = buildApp();

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  // Purge des sessions expirées toutes les 10 minutes
  setInterval(purgeExpiredSessions, 10 * 60 * 1000);

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
