import { cn } from '../../lib/utils';

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-5 w-5 animate-spin text-primary', className)}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="panel-surface-muted flex items-center gap-3 px-5 py-4 text-sm text-muted-foreground">
        <Spinner className="h-7 w-7" />
        Chargement...
      </div>
    </div>
  );
}
