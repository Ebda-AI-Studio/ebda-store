import type { ZodTypeAny, z } from 'zod';
import { AppError } from '../middleware/error-handler';

/**
 * Validate with a schema that may come from `@force/shared` and answer 400
 * `VALIDATION_ERROR` in the same shape `errorHandler` gives a ZodError.
 *
 * Why not `schema.parse()`: a schema built in `@force/shared` can throw a
 * ZodError from a DIFFERENT zod module instance than the one errorHandler's
 * `instanceof ZodError` checks (dual CJS/ESM load — measured under vitest:
 * `instanceof` was false and a bad body answered 500). safeParse never throws,
 * so the status cannot depend on which copy of zod built the schema.
 */
export function parseInput<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const details: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const path = issue.path.join('.');
    (details[path] ??= []).push(issue.message);
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request data', details);
}
