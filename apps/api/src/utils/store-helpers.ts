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
