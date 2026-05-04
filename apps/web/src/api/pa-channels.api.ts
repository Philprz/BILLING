export interface PaChannel {
  id: string;
  name: string;
  protocol: 'SFTP' | 'API';
  host: string | null;
  port: number | null;
  user: string | null;
  passwordEncrypted: string | null;
  sshPublicKey: string | null;
  remotePathIn: string | null;
  remotePathProcessed: string | null;
  remotePathOut: string | null;
  apiBaseUrl: string | null;
  apiAuthType: 'BASIC' | 'API_KEY' | 'OAUTH2' | null;
  apiCredentialsEncrypted: string | null;
  pollIntervalSeconds: number;
  active: boolean;
  lastPollAt: string | null;
  lastPollError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaChannelBody {
  name: string;
  protocol: 'SFTP' | 'API';
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  sshPublicKey?: string | null;
  remotePathIn?: string | null;
  remotePathProcessed?: string | null;
  remotePathOut?: string | null;
  apiBaseUrl?: string | null;
  apiAuthType?: 'BASIC' | 'API_KEY' | 'OAUTH2' | null;
  apiCredentials?: string | null;
  pollIntervalSeconds?: number;
  active?: boolean;
}

export type PatchPaChannelBody = Partial<Omit<CreatePaChannelBody, 'protocol'>>;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init });
  const json = await res.json();
  if (!json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

export async function apiGetPaChannels(): Promise<PaChannel[]> {
  return apiFetch<PaChannel[]>('/api/pa-channels');
}

export async function apiCreatePaChannel(body: CreatePaChannelBody): Promise<PaChannel> {
  return apiFetch<PaChannel>('/api/pa-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiPatchPaChannel(id: string, body: PatchPaChannelBody): Promise<PaChannel> {
  return apiFetch<PaChannel>(`/api/pa-channels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiDeletePaChannel(id: string): Promise<void> {
  await apiFetch<void>(`/api/pa-channels/${id}`, { method: 'DELETE' });
}
