'use client';

import type { ReactNode } from 'react';

type AlertVariant = 'info' | 'success' | 'warning' | 'destructive';

interface AlertProps {
  variant?: AlertVariant;
  /** Optional bold heading rendered above the description. */
  title?: ReactNode;
  /** Main body content. Accepts ReactNode so callers can embed links, codes, tables, etc. */
  description?: ReactNode;
  /** Optional leading icon (SVG or any ReactNode). Rendered on the start side. */
  icon?: ReactNode;
  /** Optional trailing action (button, link) rendered on the end side. */
  action?: ReactNode;
  /** Extra classes appended to the outer container. */
  className?: string;
  /**
   * When true, renders a more compact padded layout suitable for inline
   * banners inside cards/drawers.
   */
  compact?: boolean;
  /** Override children take precedence over `description` for custom layouts. */
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  // Each variant uses the semantic token pair with a translucent background
  // so the alert reads correctly against both light and dark page themes.
  info: 'border-info/40 bg-info/10 text-info-ink',
  success: 'border-success/40 bg-success/10 text-success-ink',
  warning: 'border-warning/40 bg-warning/10 text-warning-ink',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive-ink',
};

/**
 * Shared banner used across admin for DNS instructions, status messages,
 * and similar callouts. Replaces a handful of inline `border-warning/40
 * bg-warning/10 text-warning-ink` blocks with a semantic `warning` variant
 * so dark mode + theme overrides stay consistent.
 */
export function Alert({
  variant = 'info',
  title,
  description,
  icon,
  action,
  className,
  compact,
  children,
}: AlertProps) {
  const padding = compact ? 'p-3' : 'p-4';
  const classes = `rounded-lg border ${padding} ${VARIANT_CLASSES[variant]}${
    className ? ` ${className}` : ''
  }`;

  return (
    <div role={variant === 'destructive' ? 'alert' : 'status'} className={classes}>
      <div className="flex items-start gap-3">
        {icon ? <div className="shrink-0 mt-0.5">{icon}</div> : null}
        <div className="flex-1 min-w-0">
          {title ? <p className="text-sm font-medium">{title}</p> : null}
          {children ? (
            children
          ) : description ? (
            <div className={title ? 'mt-1 text-sm' : 'text-sm'}>{description}</div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}
