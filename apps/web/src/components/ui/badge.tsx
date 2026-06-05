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
  // #E67E22 — orange distinct du rouge REJETÉ et du vert INTÉGRÉE
  DISPUTED: {
    label: 'Litige',
    className:
      'border-[#E67E22]/40 bg-[#E67E22]/10 text-[#E67E22] dark:text-[#F39C42] dark:border-[#F39C42]/40',
  },
  SUPERSEDED: {
    label: 'Remplacée',
    className: 'border-slate-400/30 bg-slate-400/10 text-slate-500 dark:text-slate-400',
  },
  ERROR: { label: 'Erreur', className: 'border-destructive/30 bg-destructive/10 text-destructive' },
};

export function StatusBadge({
  status,
  onClick,
  title,
}: {
  status: InvoiceStatus;
  onClick?: () => void;
  title?: string;
}) {
  const cfg = STATUS_CONFIG[status];
  const baseClassName =
    'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={`Statut : ${cfg.label} — cliquer pour modifier`}
        className={cn(
          baseClassName,
          cfg.className,
          'cursor-pointer transition-colors hover:brightness-110 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-ring',
        )}
      >
        {cfg.label}
      </button>
    );
  }

  return (
    <span
      role="status"
      aria-label={`Statut : ${cfg.label}`}
      className={cn(baseClassName, cfg.className)}
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
