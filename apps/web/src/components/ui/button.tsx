import { cn } from '../../lib/utils';
import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  className,
  variant = 'default',
  size = 'md',
  loading,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      aria-disabled={disabled || loading || undefined}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
        {
          'bg-brand-gradient bg-[length:180%_180%] text-primary-foreground shadow-brand hover:-translate-y-0.5 hover:brightness-110 hover:shadow-glow':
            variant === 'default',
          'border border-secondary/30 bg-secondary/10 text-secondary-foreground hover:border-secondary/50 hover:bg-secondary/20':
            variant === 'secondary',
          'border border-input/90 bg-background/70 text-foreground shadow-soft hover:border-primary/40 hover:bg-muted/60':
            variant === 'outline',
          'text-muted-foreground hover:bg-muted/60 hover:text-foreground': variant === 'ghost',
          'border border-destructive/30 bg-destructive text-destructive-foreground shadow-soft hover:bg-destructive/90':
            variant === 'destructive',
          'h-9 px-3 text-sm': size === 'sm',
          'h-11 px-4 text-sm': size === 'md',
          'h-12 px-6 text-base': size === 'lg',
        },
        className,
      )}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  );
}
