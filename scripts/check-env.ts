import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

type Severity = 'ERROR' | 'WARN' | 'OK';

interface CheckResult {
  severity: Severity;
  message: string;
}

function exists(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWritableDirectory(target: string): boolean {
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.probe-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf-8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function report(results: CheckResult[]): number {
  let errors = 0;

  for (const result of results) {
    const prefix = `[${result.severity}]`;
    console.log(`${prefix} ${result.message}`);
    if (result.severity === 'ERROR') errors++;
  }

  return errors;
}

function main(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  const results: CheckResult[] = [];

  if (!fs.existsSync(envPath)) {
    results.push({ severity: 'ERROR', message: `Fichier .env absent (${envPath})` });
    process.exit(report(results));
  }

  const requiredVars = [
    'DATABASE_URL',
    'API_PORT',
    'APP_HOST',
    'CORS_ORIGIN',
    'SESSION_COOKIE_SECRET',
  ] as const;

  for (const key of requiredVars) {
    if (!exists(process.env[key])) {
      results.push({ severity: 'ERROR', message: `Variable obligatoire manquante: ${key}` });
    } else {
      results.push({ severity: 'OK', message: `${key} défini` });
    }
  }

  const optionalButImportant = [
    'FILE_STORAGE_PATH',
    'SAP_REST_BASE_URL',
    'SAP_CLIENT',
    'SAP_USER',
    'SAP_CLIENT_PASSWORD',
  ] as const;

  for (const key of optionalButImportant) {
    if (!exists(process.env[key])) {
      if (key === 'FILE_STORAGE_PATH') {
        results.push({ severity: 'WARN', message: 'FILE_STORAGE_PATH non défini (fallback local utilisé: <repo>\\data)' });
      } else {
        results.push({ severity: 'WARN', message: `Variable SAP non définie: ${key} (login SAP réel indisponible)` });
      }
    } else {
      results.push({ severity: 'OK', message: `${key} défini` });
    }
  }

  const storagePath = process.env.FILE_STORAGE_PATH
    ? path.resolve(process.env.FILE_STORAGE_PATH)
    : path.resolve(process.cwd(), 'data');

  if (isWritableDirectory(storagePath)) {
    results.push({ severity: 'OK', message: `Répertoire de stockage accessible en écriture (${storagePath})` });
  } else {
    results.push({ severity: 'ERROR', message: `Répertoire de stockage non accessible en écriture (${storagePath})` });
  }

  const statusOutPath = process.env.STATUS_OUT_PATH
    ? path.resolve(process.env.STATUS_OUT_PATH)
    : path.resolve(storagePath, 'status-out');

  if (isWritableDirectory(statusOutPath)) {
    results.push({ severity: 'OK', message: `Répertoire de retour statut PA accessible (${statusOutPath})` });
  } else {
    results.push({ severity: 'ERROR', message: `Répertoire de retour statut PA non accessible (${statusOutPath})` });
  }

  const retryDelays = process.env.PA_STATUS_RETRY_DELAYS_MS ?? '0,60000,300000';
  const validRetryDelays = retryDelays
    .split(',')
    .map((value) => Number(value.trim()))
    .every((value) => Number.isFinite(value) && value >= 0);

  if (!validRetryDelays) {
    results.push({ severity: 'ERROR', message: 'PA_STATUS_RETRY_DELAYS_MS invalide (format attendu: 0,60000,300000)' });
  } else {
    results.push({ severity: 'OK', message: `PA_STATUS_RETRY_DELAYS_MS valide (${retryDelays})` });
  }

  const errors = report(results);
  if (errors > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('Environnement local valide.');
}

main();
