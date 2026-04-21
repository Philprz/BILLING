import { cn } from '../../lib/utils';
import type { InvoiceStatus } from '../../api/types';

const STATUS_CONFIG: Record<InvoiceStatus, { label: string; className: string }> = {
  NEW:       { label: 'Nouvelle',    className: 'bg-slate-100 text-slate-700 border-slate-200' },
  TO_REVIEW: { label: 'À réviser',   className: 'bg-amber-100 text-amber-700 border-amber-200' },
  READY:     { label: 'Prête',       className: 'bg-blue-100 text-blue-700 border-blue-200' },
  POSTED:    { label: 'Intégrée',    className: 'bg-green-100 text-green-700 border-green-200' },
  REJECTED:  { label: 'Rejetée',     className: 'bg-red-100 text-red-700 border-red-200' },
  ERROR:     { label: 'Erreur',      className: 'bg-red-100 text-red-700 border-red-200' },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', cfg.className)}>
      {cfg.label}
    </span>
  );
}

export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground', className)}>
      {children}
    </span>
  );
}
