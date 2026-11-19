/**
 * STATUS-WINDOW-1: the headline uptime of a component is the LAST 30 DAYS, computed from the same daily buckets as the 90-day figure
 * (`days`, oldest first, today last). A day with no checks counts for nothing, so a window with no data at all is `null`, never 100 %.
 */
export const HEADLINE_DAYS = 30;

interface UptimeBucket {
  checks: number;
  ok: number;
}

/** Percentage (2 decimals) over the LAST `n` buckets of `days`, or null when those buckets hold no checks. */
export function uptimeOver(days: readonly UptimeBucket[], n: number): number | null {
  const win = n >= days.length ? days : days.slice(days.length - n);
  const checks = win.reduce((s, d) => s + d.checks, 0);
  const ok = win.reduce((s, d) => s + d.ok, 0);
  return checks ? Math.round((ok / checks) * 10000) / 100 : null;
}
