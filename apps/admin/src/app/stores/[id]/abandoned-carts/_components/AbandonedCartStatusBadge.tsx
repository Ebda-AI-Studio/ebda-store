'use client';

import { useT } from '@/i18n/useT';

/**
 * Status pill specific to abandoned-cart records. The colors differ from the
 * shared `OrderStatusBadge` because the step-sent statuses are informational
 * (not order-lifecycle steps), so they use the `info` token. Labels are
 * translated from `abandonedCarts.status.<status>` and fall back to the raw
 * value for unknown statuses.
 */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/10 text-warning dark:bg-warning/30 dark:text-warning',
  step1_sent: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  step2_sent: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  step3_sent: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  recovered: 'bg-success/10 text-success dark:bg-success/30 dark:text-success',
  expired: 'bg-muted text-muted-foreground',
};

const KNOWN_STATUSES = new Set(Object.keys(STATUS_COLORS));

export function AbandonedCartStatusBadge({ status }: { status: string }) {
  const t = useT('abandonedCarts.status');
  const cls = STATUS_COLORS[status] ?? 'bg-muted text-muted-foreground';
  const label = KNOWN_STATUSES.has(status) ? t(status) : status;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>;
}
