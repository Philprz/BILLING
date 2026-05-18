import '@fastify/cookie';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getSession, slideIdleExpiry } from '../session/store';
import { COOKIE_NAME, IDLE_TIMEOUT_MINUTES } from '../config';
import type { AppRole, SapSession } from '../session/store';

/** Identité applicative attachée à chaque requête authentifiée */
export interface RequestUser {
  userId: string;
  sapUsername: string;
  companyDb: string;
  displayName: string;
  role: AppRole;
  /** Cookie B1SESSION à réinjecter vers SAP côté serveur (jamais exposé au front) */
  b1Session: string;
  sapCookieHeader: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    sapSession?: SapSession;
    user?: RequestUser;
  }
}

/**
 * Middleware Fastify (preHandler) à placer sur les routes protégées.
 * Valide le cookie signé, glisse l'échéance d'inactivité (sans dépasser l'absolu),
 * et attache request.user (typé) + request.sapSession.
 * Retourne 401 si absent ou expiré.
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[COOKIE_NAME] ?? '';
  const unsigned = request.unsignCookie(raw);

  if (!unsigned.valid || !unsigned.value) {
    return reply.code(401).send({ success: false, error: 'Authentification requise' });
  }

  const existing = getSession(unsigned.value);
  if (!existing) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(401).send({ success: false, error: 'SESSION_EXPIRED' });
  }

  const session = slideIdleExpiry(existing.sessionId, IDLE_TIMEOUT_MINUTES) ?? existing;

  request.sapSession = session;
  request.user = {
    userId: session.userId,
    sapUsername: session.sapUser,
    companyDb: session.companyDb,
    displayName: session.displayName,
    role: session.role,
    b1Session: session.b1Session,
    sapCookieHeader: session.sapCookieHeader,
    sessionId: session.sessionId,
  };
}
