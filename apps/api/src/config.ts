export const COOKIE_NAME = 'pa_session' as const;

export const SESSION_DURATION_MINUTES = Math.max(
  5,
  Number(process.env.SESSION_DURATION_MINUTES ?? '60'),
);

export function resolveSessionDurationMinutes(sapSessionTimeoutMinutes: number): number {
  const safeSapTimeout =
    Number.isFinite(sapSessionTimeoutMinutes) && sapSessionTimeoutMinutes > 0
      ? sapSessionTimeoutMinutes
      : SESSION_DURATION_MINUTES;

  return Math.min(SESSION_DURATION_MINUTES, safeSapTimeout);
}

// dev-only : bypass du certificat auto-signé SAP B1
export const SAP_IGNORE_SSL = process.env.SAP_IGNORE_SSL === 'true';
