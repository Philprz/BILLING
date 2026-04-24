export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getCsrfToken(): string {
  return (
    document.cookie
      .split('; ')
      .find((r) => r.startsWith('csrf_token='))
      ?.split('=')[1] ?? ''
  );
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

  if (res.status === 401) {
    throw new ApiError('Session expirée', 401);
  }

  let body: { success: boolean; data?: T; error?: string };
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`Réponse invalide du serveur (HTTP ${res.status})`, res.status);
  }

  if (!res.ok || !body.success) {
    throw new ApiError(body.error ?? `Erreur serveur (${res.status})`, res.status);
  }

  return body.data as T;
}
