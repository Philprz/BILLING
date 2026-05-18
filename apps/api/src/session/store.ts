import { randomUUID } from 'node:crypto';

export type AppRole = 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';

export interface SapSession {
  sessionId: string;
  /** Valeur du cookie B1SESSION SAP — stockée côté serveur uniquement */
  b1Session: string;
  /** En-tête Cookie complet à réinjecter vers SAP (B1SESSION, ROUTEID, etc.) */
  sapCookieHeader: string;
  /** Timeout réel annoncé par SAP au login (informatif) */
  sessionTimeoutMinutes: number;
  companyDb: string;
  sapUser: string;
  /** Identifiant interne app_users */
  userId: string;
  /** Nom d'affichage NOVA PA (depuis app_users.displayName) */
  displayName: string;
  /** Rôle applicatif NOVA PA (depuis app_users.role) */
  role: AppRole;
  createdAt: Date;
  /** Échéance d'inactivité (sliding) — recalculée à chaque requête authentifiée */
  idleExpiresAt: Date;
  /** Plafond absolu de la session — jamais dépassé, même par sliding */
  absoluteExpiresAt: Date;
  /** Alias = min(idleExpiresAt, absoluteExpiresAt) — utilisé pour cookie + réponses */
  expiresAt: Date;
}

// Map en mémoire : sessionId (UUID) → SapSession
// B1SESSION n'est jamais envoyé au navigateur
const store = new Map<string, SapSession>();

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export function createSession(
  data: Pick<
    SapSession,
    | 'b1Session'
    | 'companyDb'
    | 'sapUser'
    | 'sessionTimeoutMinutes'
    | 'userId'
    | 'displayName'
    | 'role'
    | 'idleExpiresAt'
    | 'absoluteExpiresAt'
  > &
    Partial<Pick<SapSession, 'sapCookieHeader'>>,
): SapSession {
  const session: SapSession = {
    ...data,
    sapCookieHeader: data.sapCookieHeader ?? `B1SESSION=${data.b1Session}`,
    sessionId: randomUUID(),
    createdAt: new Date(),
    expiresAt: minDate(data.idleExpiresAt, data.absoluteExpiresAt),
  };
  store.set(session.sessionId, session);
  return session;
}

export function getSession(sessionId: string): SapSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;
  const now = new Date();
  if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    deleteSession(sessionId);
    return undefined;
  }
  return session;
}

export function deleteSession(sessionId: string): void {
  store.delete(sessionId);
}

export function updateSession(
  sessionId: string,
  patch: Partial<
    Pick<
      SapSession,
      | 'idleExpiresAt'
      | 'absoluteExpiresAt'
      | 'sapCookieHeader'
      | 'b1Session'
      | 'sessionTimeoutMinutes'
    >
  >,
): SapSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;

  const merged: SapSession = { ...session, ...patch };
  merged.expiresAt = minDate(merged.idleExpiresAt, merged.absoluteExpiresAt);

  store.set(sessionId, merged);
  return merged;
}

/**
 * Glisse idleExpiresAt à now+ttl, jamais au-delà de absoluteExpiresAt.
 * Retourne la session mise à jour ou undefined si introuvable / déjà expirée.
 */
export function slideIdleExpiry(sessionId: string, ttlMinutes: number): SapSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;
  const newIdle = new Date(Date.now() + ttlMinutes * 60_000);
  return updateSession(sessionId, {
    idleExpiresAt: minDate(newIdle, session.absoluteExpiresAt),
  });
}

export function countActiveSessions(): number {
  const now = new Date();
  let count = 0;
  for (const s of store.values()) {
    if (s.expiresAt > now) count++;
  }
  return count;
}

/** Purge périodique pour éviter les fuites mémoire */
export function purgeExpiredSessions(): void {
  const now = new Date();
  for (const [id, s] of store.entries()) {
    if (s.expiresAt <= now) store.delete(id);
  }
}
