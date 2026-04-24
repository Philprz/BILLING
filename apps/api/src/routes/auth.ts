import '@fastify/cookie';
import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sapLogin, sapLogout, sapPing, SapAuthError } from '../services/sap-auth.service';
import { createSession, getSession, deleteSession, updateSession } from '../session/store';
import { createAuditLogBestEffort } from '@pa-sap-bridge/database';
import { COOKIE_NAME, resolveSessionDurationMinutes } from '../config';

// Sociétés SAP autorisées (issues des variables d'env uniquement)
const ALLOWED_COMPANIES = new Set(
  [process.env.SAP_CLIENT, process.env.SAP_CLIENT_RONDOT].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  ),
);

interface LoginBody {
  companyDb: string;
  userName: string;
  password: string;
}

function computeSessionExpiry(sessionTimeoutMinutes: number): Date {
  const durationMinutes = resolveSessionDurationMinutes(sessionTimeoutMinutes);
  return new Date(Date.now() + durationMinutes * 60 * 1000);
}

function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
    signed: true,
  });
}

function setCsrfCookie(reply: FastifyReply, expiresAt: Date): void {
  const token = randomBytes(32).toString('hex');
  reply.setCookie('csrf_token', token, {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ----------------------------------------------------------------
  // POST /api/auth/login
  // ----------------------------------------------------------------
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      config: {
        // 10 tentatives par IP sur 15 minutes (CDC §3.3)
        rateLimit: { max: 10, timeWindow: '15 minutes' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['companyDb', 'userName', 'password'],
          properties: {
            companyDb: { type: 'string', minLength: 1 },
            userName: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { companyDb, userName, password } = request.body;

      // Validation société (liste blanche env)
      if (ALLOWED_COMPANIES.size > 0 && !ALLOWED_COMPANIES.has(companyDb)) {
        return reply.code(400).send({ success: false, error: 'Société non autorisée' });
      }

      try {
        const { b1Session, sapCookieHeader, sessionTimeoutMinutes } = await sapLogin(
          companyDb,
          userName,
          password,
        );

        const expiresAt = computeSessionExpiry(sessionTimeoutMinutes);
        const session = createSession({
          b1Session,
          sapCookieHeader,
          companyDb,
          sapUser: userName,
          expiresAt,
          sessionTimeoutMinutes,
        });

        // Audit login OK
        await createAuditLogBestEffort({
          action: 'LOGIN',
          entityType: 'SYSTEM',
          sapUser: userName,
          outcome: 'OK',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          payloadAfter: { companyDb, sessionTimeoutMinutes },
        });

        // Cookie httpOnly signé — le navigateur ne voit jamais le B1SESSION
        setSessionCookie(reply, session.sessionId, expiresAt);
        setCsrfCookie(reply, expiresAt);

        return reply.send({
          success: true,
          data: {
            user: userName,
            companyDb,
            expiresAt: expiresAt.toISOString(),
          },
        });
      } catch (err) {
        const isAuth = err instanceof SapAuthError;
        const message = isAuth ? err.message : 'Erreur de connexion SAP';
        const httpCode = isAuth ? err.statusCode : 502;

        // Audit login KO (best-effort, sans masquer l'erreur principale)
        await createAuditLogBestEffort({
          action: 'LOGIN',
          entityType: 'SYSTEM',
          sapUser: userName,
          outcome: 'ERROR',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          errorMessage: err instanceof Error ? err.message : String(err),
          payloadAfter: { companyDb },
        });

        return reply.code(httpCode).send({ success: false, error: message });
      }
    },
  );

  // ----------------------------------------------------------------
  // POST /api/auth/logout
  // ----------------------------------------------------------------
  app.post('/api/auth/logout', async (request, reply) => {
    const raw = request.cookies[COOKIE_NAME] ?? '';
    const unsigned = request.unsignCookie(raw);

    if (unsigned.valid && unsigned.value) {
      const session = getSession(unsigned.value);
      if (session) {
        await sapLogout(session.sapCookieHeader);

        await createAuditLogBestEffort({
          action: 'LOGOUT',
          entityType: 'SYSTEM',
          sapUser: session.sapUser,
          outcome: 'OK',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        deleteSession(unsigned.value);
      }
    }

    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ success: true });
  });

  // ----------------------------------------------------------------
  // GET /api/auth/me — vérification de l'état de session
  // ----------------------------------------------------------------
  app.get('/api/auth/me', async (request, reply) => {
    const raw = request.cookies[COOKIE_NAME] ?? '';
    const unsigned = request.unsignCookie(raw);

    if (!unsigned.valid || !unsigned.value) {
      return reply.code(401).send({ success: false, error: 'Non authentifié' });
    }

    const session = getSession(unsigned.value);
    if (!session) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.code(401).send({ success: false, error: 'Session expirée' });
    }

    return reply.send({
      success: true,
      data: {
        user: session.sapUser,
        companyDb: session.companyDb,
        expiresAt: session.expiresAt.toISOString(),
      },
    });
  });

  // ----------------------------------------------------------------
  // POST /api/auth/keepalive — prolonge la session locale si SAP répond
  // ----------------------------------------------------------------
  app.post('/api/auth/keepalive', async (request, reply) => {
    const raw = request.cookies[COOKIE_NAME] ?? '';
    const unsigned = request.unsignCookie(raw);

    if (!unsigned.valid || !unsigned.value) {
      return reply.code(401).send({ success: false, error: 'Authentification requise' });
    }

    const session = getSession(unsigned.value);
    if (!session) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.code(401).send({ success: false, error: 'Session expirée' });
    }

    const pingOk = await sapPing(session.sapCookieHeader);
    if (!pingOk) {
      deleteSession(session.sessionId);
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.code(401).send({ success: false, error: 'Session SAP expirée ou invalide' });
    }

    const expiresAt = computeSessionExpiry(session.sessionTimeoutMinutes);
    updateSession(session.sessionId, { expiresAt });
    setSessionCookie(reply, session.sessionId, expiresAt);
    setCsrfCookie(reply, expiresAt);

    return reply.send({
      success: true,
      data: {
        user: session.sapUser,
        companyDb: session.companyDb,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });
}
