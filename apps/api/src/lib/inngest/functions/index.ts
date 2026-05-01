import type { InngestFunction } from 'inngest';
import { orderCreated } from './order-created';
import { bulkImportProducts } from './bulk-import';

/**
 * Registry of every Inngest function the API exposes. The serve
 * handler in `apps/api/src/index.ts` mounts this list at
 * `/api/v1/inngest`. Functions added here are picked up by the
 * Inngest platform on the next deploy / dev sync.
 */
export const inngestFunctions: InngestFunction.Any[] = [orderCreated, bulkImportProducts];
