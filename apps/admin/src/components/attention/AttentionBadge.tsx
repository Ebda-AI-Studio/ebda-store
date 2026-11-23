'use client';

import { useT } from '@/i18n/useT';

/**
 * The "needs attention" marker: a count pill in the palette's warning (brass) token, never orange.
 * `count > 0` = action needed (pill with the number); `quiet` = only an info note (small hollow dot).
 * The accessible name says what it means; the number alone would not.
 */
export function AttentionBadge({
  count,
  quiet = false,
  className = '',
}: {
  count: number;
  quiet?: boolean;
  className?: string;
}) {
  const t = useT('attention');
  if (count > 0) {
    return (
      <span
        role="img"
        aria-label={t('badge', { count })}
        data-testid="attention-badge"
        className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-xs font-semibold leading-none text-warning-foreground ${className}`}
      >
        <span aria-hidden="true">{count}</span>
      </span>
    );
  }
  if (quiet) {
    return (
      <span
        role="img"
        aria-label={t('infoDot')}
        data-testid="attention-dot"
        className={`inline-block h-2 w-2 rounded-full border border-warning ${className}`}
      />
    );
  }
  return null;
}
