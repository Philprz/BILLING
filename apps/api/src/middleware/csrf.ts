import type { FastifyRequest, FastifyReply } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = new Set(['/api/auth/login']);

export async function verifyCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;
  if (CSRF_EXEMPT.has(request.url.split('?')[0])) return;

  const cookieToken = request.cookies['csrf_token'];
  const headerToken = request.headers['x-csrf-token'];

  if (!cookieToken || cookieToken !== headerToken) {
    return reply.code(403).send({ success: false, error: 'CSRF token invalide' });
  }
}
