import { Request } from 'express';
import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { AuthPayload } from '../middleware/auth';

/**
 * Extracts the authenticated user from the request.
 * Use in routes that run after the `authenticate` middleware —
 * this replaces the `req.user!` non-null assertion with a proper runtime check.
 */
export function getAuthUser(req: Request): AuthPayload {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  }
  return req.user;
}

/**
 * Get store ID from request context.
 *
 * Resolution order (any step that fails is a hard 400 — we do NOT silently
 * fall back to the first-created store, which used to leak Palora's
 * catalogue into every other storefront's SSR requests):
 *   1. X-Store-ID header — validated against the DB.
 *   2. x-store-domain header — looked up by domain (normalized: stripped
 *      `www.`, lowercased).
 *   3. Otherwise throw AppError 400.
 */
export async function getStoreIdFromRequest(req: Request): Promise<string> {
  const headerStoreId = req.headers['x-store-id'] as string | undefined;
  if (headerStoreId) {
    const store = await prisma.store.findFirst({
      where: { id: headerStoreId, status: 'active' },
      select: { id: true },
    });
    if (store) return store.id;
  }

  const rawDomain = req.headers['x-store-domain'] as string | undefined;
  if (rawDomain) {
    const domain = rawDomain.toLowerCase().replace(/^www\./, '');
    const store = await prisma.store.findFirst({
      where: { domain, status: 'active' },
      select: { id: true },
    });
    if (store) return store.id;
  }

  throw new AppError(
    400,
    'STORE_NOT_RESOLVED',
    'Unable to resolve store context. Provide X-Store-ID or x-store-domain header.'
  );
}
