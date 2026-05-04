import { randomBytes } from 'crypto';
import { buildApp } from '../../apps/api/src/app';
import { createSession } from '../../apps/api/src/session/store';
import { COOKIE_NAME } from '../../apps/api/src/config';

export async function buildAuthenticatedApp(user = 'vitest.user') {
  const app = buildApp();
  await app.ready();

  const session = createSession({
    b1Session: 'VITEST-B1SESSION',
    sapCookieHeader: 'B1SESSION=VITEST-B1SESSION; ROUTEID=.node1',
    companyDb: 'VITEST_DB',
    sapUser: user,
    sessionTimeoutMinutes: 30,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });

  const csrfToken = randomBytes(32).toString('hex');
  const cookieHeader = `${COOKIE_NAME}=${app.signCookie(session.sessionId)}; csrf_token=${csrfToken}`;

  return { app, cookieHeader, session, csrfToken };
}
