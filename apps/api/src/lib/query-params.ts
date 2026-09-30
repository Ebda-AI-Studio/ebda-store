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
