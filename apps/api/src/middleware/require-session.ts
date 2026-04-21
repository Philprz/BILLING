import '@fastify/cookie';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getSession } from '../session/store';
import { COOKIE_NAME } from '../config';
import type { SapSession } from '../session/store';

// Augmentation du type FastifyRequest pour les routes protégées
declare module 'fastify' {
  interface FastifyRequest {
    sapSession?: SapSession;
  }
}

/**
 * Middleware Fastify (preHandler) à placer sur les routes protégées.
 * Valide le cookie signé et attache la session à request.sapSession.
 * Retourne 401 si absent ou expiré.
 */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = request.cookies[COOKIE_NAME] ?? '';
  const unsigned = request.unsignCookie(raw);

  if (!unsigned.valid || !unsigned.value) {
    return reply.code(401).send({ success: false, error: 'Authentification requise' });
  }

  const session = getSession(unsigned.value);
  if (!session) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(401).send({ success: false, error: 'Session expirée ou invalide' });
  }

  request.sapSession = session;
}
