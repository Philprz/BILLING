import { cn } from '../../lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-muted/60', className)} />;
}

export function InvoiceListSkeleton() {
  return (
    <div className="space-y-2 px-6 py-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-2">
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function InvoiceDetailSkeleton() {
  return (
    <div className="app-page space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-32" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-24" />
        </div>
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="app-page space-y-4">
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-52" />
      <Skeleton className="h-64" />
    </div>
  );
}
