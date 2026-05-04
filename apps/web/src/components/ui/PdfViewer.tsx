import { useEffect, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';

interface PdfViewerProps {
  url: string;
  filename?: string;
}

export function PdfViewer({ url, filename }: PdfViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setBlobUrl(null);

    let objectUrl: string | null = null;

    fetch(url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Chargement du document…
      </div>
    );
  }

  if (error || !blobUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span>Impossible de charger le PDF</span>
        {error && <span className="text-xs text-muted-foreground">{error}</span>}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center gap-1 text-xs text-primary underline"
        >
          <ExternalLink className="h-3 w-3" /> Ouvrir dans un nouvel onglet
        </a>
      </div>
    );
  }

  return <iframe src={blobUrl} title={filename} className="h-full w-full border-0 bg-white" />;
}
