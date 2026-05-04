import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

// ─── XML → pretty-printed string ─────────────────────────────────────────────

function serializeNode(node: Node, depth: number): string {
  const pad = '  '.repeat(depth);

  if (node.nodeType === Node.DOCUMENT_NODE) {
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
    for (const child of node.childNodes) out += serializeNode(child, 0);
    return out;
  }
  if (node.nodeType === Node.COMMENT_NODE) return `${pad}<!--${node.nodeValue}-->\n`;
  if (node.nodeType === Node.CDATA_SECTION_NODE) return `${pad}<![CDATA[${node.nodeValue}]]>\n`;
  if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
    const pi = node as ProcessingInstruction;
    return `${pad}<?${pi.target} ${pi.data}?>\n`;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').trim();
    return t ? `${pad}${t}\n` : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName;
  const attrs = Array.from(el.attributes)
    .map((a) => ` ${a.name}="${a.value}"`)
    .join('');

  const kids = Array.from(el.childNodes).filter(
    (c) => c.nodeType !== Node.TEXT_NODE || (c.textContent ?? '').trim(),
  );

  if (kids.length === 0) return `${pad}<${tag}${attrs}/>\n`;

  // Single text child → keep on one line
  if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
    const text = (kids[0].textContent ?? '').trim();
    return `${pad}<${tag}${attrs}>${text}</${tag}>\n`;
  }

  let out = `${pad}<${tag}${attrs}>\n`;
  for (const child of el.childNodes) out += serializeNode(child, depth + 1);
  return out + `${pad}</${tag}>\n`;
}

function formatXml(raw: string): string {
  try {
    const doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (doc.querySelector('parseerror')) return raw;
    return serializeNode(doc, 0);
  } catch {
    return raw;
  }
}

// ─── Syntax highlighting via HTML escaping + regex spans ──────────────────────

function highlightXml(formatted: string): string {
  // Step 1: HTML-escape everything so raw XML chars are safe in innerHTML
  const esc = formatted
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Step 2: Apply coloured <span> on the now-escaped markup patterns.
  // All patterns work on escaped sequences: &lt; = '<', &gt; = '>', &quot; = '"'

  return (
    esc
      // Comments
      .replace(
        /(&lt;!--[\s\S]*?--&gt;)/g,
        '<span style="color:#94a3b8;font-style:italic">$1</span>',
      )
      // XML declaration / processing instructions
      .replace(/(&lt;\?[\s\S]*?\?&gt;)/g, '<span style="color:#c084fc">$1</span>')
      // CDATA sections
      .replace(/(&lt;!\[CDATA\[[\s\S]*?\]\]&gt;)/g, '<span style="color:#4ade80">$1</span>')
      // Closing tags: &lt;/tagName&gt;
      .replace(/(&lt;\/)([\w:.-]+)(&gt;)/g, '<span style="color:#60a5fa">$1$2$3</span>')
      // Opening / self-closing tags with optional attributes
      .replace(
        /(&lt;)([\w:.-]+)((?:\s+[\w:.-]+=&quot;.*?&quot;)*\s*\/?&gt;)/g,
        (_full, open, name, rest) => {
          const styledAttrs = rest.replace(
            /([\w:.-]+)=(&quot;.*?&quot;)/g,
            '<span style="color:#fb923c">$1</span>=<span style="color:#4ade80">$2</span>',
          );
          return `<span style="color:#60a5fa">${open}${name}</span>${styledAttrs}`;
        },
      )
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface XmlViewerProps {
  url: string;
  filename?: string;
}

export function XmlViewer({ url, filename }: XmlViewerProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setRaw(null);
    fetch(url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setRaw(text);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
  }, [url]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Chargement du fichier…
      </div>
    );
  }

  if (error || raw === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span>Impossible de charger le fichier</span>
        {error && <span className="text-xs text-muted-foreground">{error}</span>}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 text-xs text-primary underline"
        >
          Ouvrir dans un nouvel onglet
        </a>
      </div>
    );
  }

  const formatted = formatXml(raw);
  const highlighted = highlightXml(formatted);

  return (
    <div className="flex h-full flex-col">
      {filename && (
        <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-3 py-1">
          <span className="font-mono text-[11px] text-muted-foreground">{filename}</span>
          <a href={url} download={filename} className="text-[11px] text-primary hover:underline">
            Télécharger l'original
          </a>
        </div>
      )}
      <pre
        className="flex-1 overflow-auto bg-[#0f172a] p-4 font-mono text-xs leading-relaxed text-slate-200"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: content is HTML-escaped before span injection
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}
