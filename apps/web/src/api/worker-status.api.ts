export interface WorkerChannel {
  id: string;
  name: string;
  protocol: string;
  active: boolean;
  pollIntervalSeconds: number;
  lastPollAt: string | null;
  lastPollError: string | null;
}

export interface WorkerStatusData {
  channels: WorkerChannel[];
}

export async function apiGetWorkerStatus(): Promise<WorkerStatusData> {
  const res = await fetch('/api/worker/status', { credentials: 'include' });
  const data = (await res.json()) as { success: boolean; data?: WorkerStatusData; error?: string };
  if (!data.success) throw new Error(data.error ?? 'Impossible de récupérer le statut du worker');
  return data.data!;
}
