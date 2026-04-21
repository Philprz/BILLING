import { randomUUID } from 'node:crypto';

export interface SapSession {
  sessionId: string;
  /** Valeur du cookie B1SESSION SAP — stockée côté serveur uniquement */
  b1Session: string;
  companyDb: string;
  sapUser: string;
  createdAt: Date;
  expiresAt: Date;
}

// Map en mémoire : sessionId (UUID) → SapSession
// B1SESSION n'est jamais envoyé au navigateur
const store = new Map<string, SapSession>();

export function createSession(
  data: Pick<SapSession, 'b1Session' | 'companyDb' | 'sapUser' | 'expiresAt'>,
): SapSession {
  const session: SapSession = {
    ...data,
    sessionId: randomUUID(),
    createdAt: new Date(),
  };
  store.set(session.sessionId, session);
  return session;
}

export function getSession(sessionId: string): SapSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;
  if (session.expiresAt <= new Date()) {
    deleteSession(sessionId);
    return undefined;
  }
  return session;
}

export function deleteSession(sessionId: string): void {
  store.delete(sessionId);
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
