/**
 * Which StoreDO tables hold personal data, and how a customer is found in them. Every table the live StoreDO schema
 * holds MUST be classified here before customer erasure/export may run on it (`unclassifiedTables`; the StoreDO
 * refuses a customer subject while any table is unclassified, so a missing entry fails CLOSED, never silently skips PII).
 * Column names are SQLite column names.
 *
 * STATE (INFRA-CF-1 PR C): the StoreDO carries the full generated cf-schema (122 tables) but this registry is still
 * EMPTY. The classification itself exists (packages/cf-schema/erasure-classification.json, test-enforced against the
 * schema); turning it into `match`/`scrub` entries (customerId joins, NOT NULL scrub values) is the G10 phase-1
 * follow-up and a cutover blocker. The Phase 0 entries (thin demo tables) were removed: they described tables that
 * no longer exist in that shape (carts/orders now carry customer identifiers).
 */

export type TableClass =
  | { kind: 'no-pii' }
  /** Merchant-owned content with no customer identifiers; goes with `deleteAll()` on merchant erase. */
  | { kind: 'store-owned' }
  | {
      kind: 'customer-pii';
      /** Columns that identify the customer; a row matches when ANY supplied subject key equals ONE of them. */
      match: { buyerKey?: string; email?: string; phone?: string; userId?: string };
      /** 'delete' removes the row; 'scrub' keeps it (orders keep money history) and overwrites the columns. */
      action: 'delete' | 'scrub';
      /** For 'scrub': column -> replacement (NOT NULL columns need a string, e.g. '[erased]'). */
      scrub?: Record<string, string | null>;
    };

export const STORE_DO_REGISTRY: Record<string, TableClass> = {};

export const classifiedTables = (): string[] => Object.keys(STORE_DO_REGISTRY);
/** Tables of a live StoreDO (`storeTables(sql)`) that have no registry entry. */
export const unclassifiedTables = (
  liveTables: readonly string[],
  reg: Record<string, TableClass> = STORE_DO_REGISTRY
): string[] => liveTables.filter(t => !(t in reg));
