import './env';
import { purgeExpiredSessions } from './session/store';
import { buildApp } from './app';
import { syncSuppliersFromSapEnv } from './services/sap-suppliers-sync.service';

const PORT = Number(process.env.API_PORT) || 3001;
const HOST = process.env.APP_HOST || '0.0.0.0';
const app = buildApp();
const SUPPLIERS_SYNC_ENABLED = process.env.SUPPLIERS_SYNC_ENABLED === 'true';
const SUPPLIERS_SYNC_ON_STARTUP = process.env.SUPPLIERS_SYNC_ON_STARTUP !== 'false';
const SUPPLIERS_SYNC_CRON = process.env.SUPPLIERS_SYNC_CRON ?? '0 */6 * * *';

function cronPartMatches(part: string, value: number): boolean {
  if (part === '*') return true;
  if (part.includes(',')) return part.split(',').some((p) => cronPartMatches(p, value));
  const step = part.match(/^\*\/(\d+)$/);
  if (step) return value % Number(step[1]) === 0;
  const range = part.match(/^(\d+)-(\d+)$/);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  return Number(part) === value;
}

function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cronMatches('0 */6 * * *', date);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    cronPartMatches(minute, date.getMinutes()) &&
    cronPartMatches(hour, date.getHours()) &&
    cronPartMatches(dayOfMonth, date.getDate()) &&
    cronPartMatches(month, date.getMonth() + 1) &&
    cronPartMatches(dayOfWeek, date.getDay())
  );
}

function startSuppliersSyncScheduler(): void {
  if (!SUPPLIERS_SYNC_ENABLED) return;

  let running = false;
  const run = async (source: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      app.log.info({ source }, 'Synchronisation fournisseurs SAP B1');
      const result = await syncSuppliersFromSapEnv();
      if (result.errors.length > 0) {
        app.log.error(
          { errors: result.errors, total: result.total },
          'Erreur synchro fournisseurs',
        );
      }
    } catch (err) {
      app.log.error({ err }, 'Erreur non fatale synchro fournisseurs');
    } finally {
      running = false;
    }
  };

  if (SUPPLIERS_SYNC_ON_STARTUP) {
    setTimeout(() => {
      void run('startup');
    }, 5_000);
  }
  let lastScheduledMinute = '';
  setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === lastScheduledMinute || !cronMatches(SUPPLIERS_SYNC_CRON, now)) return;
    lastScheduledMinute = minuteKey;
    void run('scheduler');
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  // Purge des sessions expirées toutes les 10 minutes
  setInterval(purgeExpiredSessions, 10 * 60 * 1000);

  try {
    await app.listen({ port: PORT, host: HOST });
    startSuppliersSyncScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
