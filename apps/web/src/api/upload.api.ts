export async function apiUploadInvoice(
  file: File,
): Promise<{ invoiceId: string; created: boolean }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/invoices/upload', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  const data = (await res.json()) as {
    success: boolean;
    data?: { invoiceId: string; created: boolean };
    error?: string;
  };
  if (!data.success) throw new Error(data.error ?? "Échec de l'import");
  return data.data!;
}
