'use client';

import { useT } from '@/i18n/useT';

/**
 * Status pill specific to return records. The return lifecycle is a superset
 * of the order lifecycle (approved/rejected/received/inspecting/completed are
 * unique to returns) and several statuses carry different color semantics from
 * orders, so this badge owns its own color table rather than reusing the
 * shared `OrderStatusBadge`. Labels come from `returns.status.<status>` and
 * fall back to the raw value so that new backend statuses still render.
 */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-warning/10 text-warning dark:bg-warning/30 dark:text-warning',
  approved: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  rejected: 'bg-destructive/10 text-destructive dark:bg-destructive/30 dark:text-destructive',
  shipped: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  received: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
  inspecting: 'bg-info/20 text-info dark:bg-info/40 dark:text-info',
  completed: 'bg-success/10 text-success dark:bg-success/30 dark:text-success',
  cancelled: 'bg-muted text-foreground',
};

const KNOWN_STATUSES = new Set(Object.keys(STATUS_COLORS));

export function ReturnStatusBadge({ status }: { status: string }) {
  const t = useT('returns.status');
  const cls = STATUS_COLORS[status] ?? 'bg-muted text-foreground';
  const label = KNOWN_STATUSES.has(status) ? t(status) : status;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>;
}
