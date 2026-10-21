import { z } from 'zod';

/**
 * Optional boolean query param, tri-state:
 *   absent  -> undefined  (no filter)
 *   'true'  -> true
 *   'false' -> false
 *   anything else (incl. repeated params, '1', 'yes') -> ZodError -> 400
 *
 * Why not `x === 'true'`: that maps ABSENT to `false`, and the product
 * services only skip a filter when it is `undefined` — so every default
 * listing silently added `WHERE featured = false` and hid any product a
 * merchant marked featured. Why not `z.coerce.boolean()`: it turns the
 * string 'false' into `true`.
 */
export const optionalBooleanQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform(v => (v === undefined ? undefined : v === 'true'));

/** Parse one raw `req.query` value; throws a ZodError (-> 400) on garbage. */
export function parseOptionalBooleanQuery(value: unknown, name: string): boolean | undefined {
  const result = optionalBooleanQuery.safeParse(value);
  if (!result.success) {
    throw new z.ZodError(
      result.error.issues.map(issue => ({ ...issue, path: [name, ...issue.path] }))
    );
  }
  return result.data;
}

/**
 * Edge check for query params that must be ONE string (pagination, filters, search terms, sort).
 * Express's `qs` turns `?a[b]=c` into an object and `?a=1&a=2` into an array; passed on with a
 * cast, an object reaches Prisma as an OPERATOR (`?category[startsWith]=x` became
 * `slug: { startsWith: 'x' }`, a slug oracle) and an array 500s. Any listed key, or any key with a
 * listed prefix (`opt_`), that is present and not a string throws a ZodError → 400
 * VALIDATION_ERROR (error-handler). Unlisted keys are ignored, as before.
 */
export function assertScalarQuery(
  query: Record<string, unknown>,
  keys: readonly string[],
  prefixes: readonly string[] = []
): void {
  const issues: z.ZodIssue[] = [];
  for (const [key, value] of Object.entries(query)) {
    const listed = keys.includes(key) || prefixes.some(p => key.startsWith(p));
    if (listed && value !== undefined && typeof value !== 'string')
      issues.push({ code: 'custom', path: [key], message: `${key} must be a single value` });
  }
  if (issues.length > 0) throw new z.ZodError(issues);
}

/** Every `/public/products` listing param (+ the `opt_<name>` option filters). */
export const PUBLIC_PRODUCT_LIST_QUERY_KEYS = [
  'page',
  'limit',
  'category',
  'search',
  'featured',
  'sort',
  'minPrice',
  'maxPrice',
  'cursor',
  'ids',
] as const;
