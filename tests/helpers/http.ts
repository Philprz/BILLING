import { buildApp } from '../../apps/api/src/app';
import { createSession } from '../../apps/api/src/session/store';
import { COOKIE_NAME } from '../../apps/api/src/config';

export async function buildAuthenticatedApp(user = 'vitest.user') {
  const app = buildApp();
  await app.ready();

  const session = createSession({
    b1Session: 'VITEST-B1SESSION',
    companyDb: 'VITEST_DB',
    sapUser: user,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });

  const cookieHeader = `${COOKIE_NAME}=${app.signCookie(session.sessionId)}`;

  return { app, cookieHeader, session };
}
