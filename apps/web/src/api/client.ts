export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });

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
