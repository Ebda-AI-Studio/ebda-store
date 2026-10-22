import type { Request } from 'express';

/**
 * The store id a public request RESOLVED to (through the host/id lookup definers), as a plain
 * synchronous value for code that cannot await (rate-limiter key generators). Set only by
 * `resolvePublicStoreId` after a successful lookup; never from a raw header or path param.
 */
const RESOLVED_STORE_ID = Symbol('ebda.resolvedStoreId');

export function setResolvedStoreId(req: Request, id: string): void {
  (req as unknown as Record<symbol, string>)[RESOLVED_STORE_ID] = id;
}

export function resolvedStoreId(req: Request): string | undefined {
  return (req as unknown as Record<symbol, string | undefined>)[RESOLVED_STORE_ID];
}
