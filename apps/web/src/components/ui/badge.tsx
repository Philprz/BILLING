import { cn } from '../../lib/utils';
import type { InvoiceStatus } from '../../api/types';

const STATUS_CONFIG: Record<InvoiceStatus, { label: string; className: string }> = {
  NEW: { label: 'Nouvelle', className: 'border-border bg-muted/60 text-foreground' },
  TO_REVIEW: { label: 'À réviser', className: 'border-warning/30 bg-warning/10 text-warning' },
  READY: { label: 'Prête', className: 'border-primary/30 bg-primary/10 text-primary' },
  POSTED: { label: 'Intégrée', className: 'border-success/30 bg-success/10 text-success' },
  LINKED: {
    label: 'Rattachée SAP',
    className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  },
  REJECTED: {
    label: 'Rejetée',
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
  ERROR: { label: 'Erreur', className: 'border-destructive/30 bg-destructive/10 text-destructive' },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      role="status"
      aria-label={`Statut : ${cfg.label}`}
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase',
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-secondary/30 bg-secondary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-secondary-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}
