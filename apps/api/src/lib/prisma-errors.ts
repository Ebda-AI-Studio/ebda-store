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
