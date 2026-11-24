/**
 * The journal reconcile's two time constants, in ONE place (Ruling DO-METRICS-1 review: a documented mirror drifts silently).
 * Read by the DO metrics (packages/repo/src/do/do-metrics.ts: journal_unrepaired_in_window / _stale) so the operator numbers use the
 * same window as the repair. PR #926's sweep (`JOURNAL_REPAIR_MAX_AGE_HOURS` env override, default 72; the grace is
 * `STUCK_ORDER_NOTIFY_MINUTES`, default 10) should import these as its defaults instead of keeping its own literals.
 * A pure constants module: no imports, safe inside a Durable Object bundle.
 */
export const JOURNAL_REPAIR_MAX_AGE_HOURS_DEFAULT = 72;
/** A paid order younger than this is skipped: its post-payment fan-out may still be running. */
export const JOURNAL_REPAIR_GRACE_MINUTES_DEFAULT = 10;
