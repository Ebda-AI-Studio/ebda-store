/**
 * The column(s) / constraint of a Prisma unique-violation (P2002), whatever engine raised it.
 *
 * The Rust engine put them in `meta.target` (an array of columns, or a constraint name). Over a
 * driver adapter (`engineType = "client"`, which this package uses) `meta.target` is absent and
 * the same facts are under `meta.driverAdapterError.cause.constraint` (`fields` or `index`).
 * Reading `meta.target` alone therefore sees nothing and treats every conflict as unknown, so
 * every caller that inspects a unique violation goes through this.
 */
export function uniqueViolationTarget(err: unknown): string[] {
  const meta = (err as { meta?: Record<string, unknown> } | null | undefined)?.meta;
  if (!meta) return [];
  const target = meta.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string' && target) return [target];
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
  const constraint = cause?.constraint as { fields?: unknown; index?: unknown } | undefined;
  if (Array.isArray(constraint?.fields)) return constraint.fields.map(String);
  if (typeof constraint?.index === 'string') return [constraint.index];
  const m = /unique constraint "([^"]+)"/.exec(String(cause?.originalMessage ?? ''));
  return m ? [m[1]] : [];
}

/** True for a Prisma unique-constraint violation (P2002), whatever engine raised it. */
export function isP2002(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 'P2002';
}

/**
 * True when the database raised GOLD_PRICE_MANAGED (SQLSTATE P0001) from `ebda_gold_price_guard`:
 * a writer tried to change the price of a gold-rate row outside the repricer (Ruling B5-13). The
 * message lives in a different place per engine (`err.message` for the Rust engine,
 * `meta.driverAdapterError.cause.originalMessage` over a driver adapter), so both are read.
 */
export function isGoldPriceManaged(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    message?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown; message?: unknown } } };
    cause?: { message?: unknown };
  };
  const cause = e.meta?.driverAdapterError?.cause;
  return [e.message, cause?.originalMessage, cause?.message, e.cause?.message].some(
    m => typeof m === 'string' && m.includes('GOLD_PRICE_MANAGED')
  );
}
