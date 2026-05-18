export const COOKIE_NAME = 'pa_session' as const;

// Timeouts NOVA PA — indépendants du SessionTimeout SAP.
// Si le B1SESSION expire côté SAP avant, le helper sapFetch interceptera
// le 401 et purgera la session NOVA PA proactivement.
export const IDLE_TIMEOUT_MINUTES = Math.max(5, Number(process.env.SESSION_IDLE_MINUTES ?? '30'));
export const ABSOLUTE_TIMEOUT_MINUTES = Math.max(
  IDLE_TIMEOUT_MINUTES,
  Number(process.env.SESSION_ABSOLUTE_MINUTES ?? String(8 * 60)),
);

// dev-only : bypass du certificat auto-signé SAP B1
export const SAP_IGNORE_SSL = process.env.SAP_IGNORE_SSL === 'true';
