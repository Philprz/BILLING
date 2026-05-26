export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const AUTH_EXPIRED_EVENT = 'nova-pa:auth-expired';

export function getCsrfToken(): string {
  return (
    document.cookie
      .split('; ')
      .find((r) => r.startsWith('csrf_token='))
      ?.split('=')[1] ?? ''
  );
}

// Endpoints d'authentification : un 401 sur /api/auth/login n'est PAS une
// session expirée — c'est un credential rejeté. On ne déclenche pas l'event
// global de redirection dans ce cas.
const AUTH_ENDPOINT_PREFIXES = ['/api/auth/login'];

function isAuthEndpoint(url: string): boolean {
  return AUTH_ENDPOINT_PREFIXES.some((p) => url.startsWith(p));
}

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();
  const isMutating = !SAFE_METHODS.has(method);
  const csrfHeaders: HeadersInit = isMutating ? { 'X-CSRF-Token': getCsrfToken() } : {};

  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: { ...csrfHeaders, ...options?.headers },
  });

  type Envelope = { success: boolean; data?: T; error?: string };
  let body: Envelope | null = null;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    if (res.status === 401 && !isAuthEndpoint(url)) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    }
    throw new ApiError(`Réponse invalide du serveur (HTTP ${res.status})`, res.status);
  }

  const errorCode = body?.error;

  if (res.status === 401 && !isAuthEndpoint(url)) {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    throw new ApiError(errorCode ?? 'SESSION_EXPIRED', 401, errorCode);
  }

  if (!res.ok || !body?.success) {
    throw new ApiError(errorCode ?? `Erreur serveur (${res.status})`, res.status, errorCode);
  }

  return body.data as T;
}
