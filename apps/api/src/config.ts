export const COOKIE_NAME = 'pa_session' as const;

export const SESSION_DURATION_MINUTES = Math.max(
  5,
  Number(process.env.SESSION_DURATION_MINUTES ?? '60'),
);

// dev-only : bypass du certificat auto-signé SAP B1
export const SAP_IGNORE_SSL = process.env.SAP_IGNORE_SSL === 'true';
