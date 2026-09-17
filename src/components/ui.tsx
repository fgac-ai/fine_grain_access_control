import type { ReactNode } from 'react';

/**
 * Shared surface primitives for the dashboard. Deliberately thin — these exist
 * so the card chrome (radius, border, background) is defined once and stays
 * consistent, not to be a general component library.
 */

export function Card({
  children,
  className = '',
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'gmail' | 'sheets' | 'docs' | 'slides' | 'primary';
}) {
  const tones = {
    default: 'bg-card border-border',
    gmail: 'bg-gmail-bg border-gmail-border',
    sheets: 'bg-sheets-bg border-sheets-border',
    docs: 'bg-docs-bg border-docs-border',
    slides: 'bg-slides-bg border-slides-border',
    primary: 'bg-primary-muted border-border',
  };

  return (
    <div className={`rounded-md border ${tones[tone]} ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-4 px-5 py-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold text-foreground">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'gmail' | 'sheets' | 'primary';

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'bg-muted text-muted-foreground',
    success: 'bg-success text-success-foreground',
    warning: 'bg-warning text-warning-foreground',
    error: 'bg-error text-error-foreground',
    info: 'bg-info text-info-foreground',
    gmail: 'bg-gmail-bg text-gmail border border-gmail-border',
    sheets: 'bg-sheets-bg text-sheets border border-sheets-border',
    primary: 'bg-primary-muted text-primary',
  };

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Primary action button styling, shared by <button> and <Link> callers. */
export const buttonPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed';

export const buttonSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed';

export const buttonDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-sm border border-destructive bg-card px-3 py-1.5 text-[13px] font-semibold text-destructive hover:bg-error disabled:opacity-50 disabled:cursor-not-allowed';

/** Empty-state block for cards with no rows yet. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-sm border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}
