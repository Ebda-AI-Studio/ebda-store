'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { cn } from '@ebda/ui/cn';

export interface EmptyStateAction {
  label: string;
  /** Navigates (renders a link). Provide `href` OR `onClick`. */
  href?: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  /** An outline SVG path (`d` attribute, 24x24 grid) or a ready icon node. */
  icon: string | ReactNode;
  /** One short sentence naming what is missing. */
  title: string;
  /** One sentence: why it is empty / what the screen is for. */
  description?: string;
  /** Extra muted line under the description (a hint, not a second CTA). */
  hint?: string;
  /** The ONE primary next action. Omit only for a filtered "no match" state. */
  action?: EmptyStateAction;
  /** Optional quieter second action (outline). */
  secondaryAction?: EmptyStateAction;
  /** Optional "learn more" link, rendered as quiet text under the buttons. */
  helpLink?: { label: string; href: string };
  /** Wrap in a bordered card (for lists that sit directly on the page background). */
  card?: boolean;
  className?: string;
}

function ActionButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant: 'default' | 'outline';
}) {
  if (action.href) {
    return (
      <Link href={action.href} className={buttonVariants({ variant, size: 'md' })}>
        {action.label}
      </Link>
    );
  }
  return (
    <Button type="button" variant={variant} size="md" onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/**
 * The ONE empty state for every admin list (UX audit #5): icon, a one-sentence why, the primary next action, and an
 * optional help link. Colours come from tokens (muted tile, gold primary CTA); the layout uses logical properties so
 * it mirrors in Arabic.
 */
export function EmptyState({
  icon,
  title,
  description,
  hint,
  action,
  secondaryAction,
  helpLink,
  card = false,
  className,
}: EmptyStateProps) {
  const body = (
    <div
      className={cn('force-empty-state px-6', className)}
      role="status"
      data-testid="empty-state"
    >
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted"
        aria-hidden="true"
      >
        {typeof icon === 'string' ? (
          <svg
            className="h-8 w-8 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
          </svg>
        ) : (
          icon
        )}
      </div>
      <p className="font-semibold text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {hint && <p className="mt-3 max-w-md text-sm text-muted-foreground">{hint}</p>}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action && <ActionButton action={action} variant="default" />}
          {secondaryAction && <ActionButton action={secondaryAction} variant="outline" />}
        </div>
      )}
      {helpLink && (
        <Link
          href={helpLink.href}
          className="mt-3 text-sm font-medium text-primary-ink hover:underline"
        >
          {helpLink.label}
        </Link>
      )}
    </div>
  );
  return card ? (
    <div className="overflow-hidden rounded-xl border border-border bg-card">{body}</div>
  ) : (
    body
  );
}
