import path from 'path';

// Racine du monorepo (trois niveaux au-dessus de apps/worker/src)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const FILE_STORAGE_PATH = process.env.FILE_STORAGE_PATH
  ? path.resolve(process.env.FILE_STORAGE_PATH)
  : path.join(REPO_ROOT, 'data');

export const INBOX_PATH = path.join(FILE_STORAGE_PATH, 'inbox');
export const PROCESSED_PATH = path.join(FILE_STORAGE_PATH, 'processed');
export const ERROR_PATH = path.join(FILE_STORAGE_PATH, 'error');
export const INVOICES_PATH = path.join(FILE_STORAGE_PATH, 'invoices');

export const PA_SOURCE_LOCAL = 'LOCAL_DEV';

export const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 30_000;

// Niveau payé (S/B 2) — cadence du job de suivi U_NOVA_Statut (poll SL + consolidation PA/SAP).
// Défaut : 15 min. Le job ne lit que l'état de règlement et réécrit l'UDF de suivi (jamais un paiement).
export const PAYMENT_STATUS_POLL_INTERVAL_MS =
  Number(process.env.PAYMENT_STATUS_POLL_INTERVAL_MS) || 15 * 60_000;
