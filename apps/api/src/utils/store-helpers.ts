import { Request } from 'express';
import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

/**
 * Returns the ID of the first store ordered by creation date.
 * Throws AppError 404 if no store exists.
 */
export async function getDefaultStoreId(): Promise<string> {
  const store = await prisma.store.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!store) {
    throw new AppError(404, 'NO_STORE', 'No store configured');
  }
  return store.id;
}

/**
 * Get store ID from request context.
 * Reads X-Store-ID header if present, otherwise falls back to default store.
 */
export async function getStoreIdFromRequest(req: Request): Promise<string> {
  const headerStoreId = req.headers['x-store-id'] as string | undefined;

  if (headerStoreId) {
    // Validate that the store exists and is active
    const store = await prisma.store.findFirst({
      where: { id: headerStoreId, status: 'active' },
      select: { id: true },
    });
    if (store) {
      return store.id;
    }
  }

  // Fall back to default store
  return getDefaultStoreId();
}
