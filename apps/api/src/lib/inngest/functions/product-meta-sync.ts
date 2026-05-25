import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import { prisma as defaultPrisma } from '@force/database';
import logger from '../../logger';

interface SyncArgs {
  event: { data: { storeId: string; productId: string; action: 'upsert' | 'delete' } };
  step: { run: (name: string, fn: () => Promise<any>) => Promise<any> };
  prisma?: typeof defaultPrisma;
}

/**
 * Fan out a product write to the WBS inngest-receiver endpoint, which
 * calls metaCatalogService.upsertProduct / deleteProduct on the Meta
 * Commerce Catalog for this merchant.
 *
 * Triggered by product.upserted + product.deleted events fired from
 * product.service.ts after successful DB writes.
 *
 * Skips silently when:
 *   - store has no meta_catalog_id (native catalog not configured)
 *   - store has no wbsBaseUrl in settings (WBS not wired for this store)
 */
export const productMetaSync = async ({
  event,
  step,
  prisma = defaultPrisma,
}: SyncArgs): Promise<{ skipped: boolean; reason?: string; status?: number }> => {
  const { storeId, productId, action } = event.data;

  return step.run('fanout-to-wbs', async () => {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { metaCatalogId: true, settings: true },
    });

    if (!store?.metaCatalogId) {
      logger.info({ storeId, productId }, 'product-meta-sync: store has no catalog, skipping');
      return { skipped: true };
    }

    const settings = (store.settings ?? {}) as Record<string, unknown>;
    const wbsBase =
      (settings.wbsBaseUrl as string | undefined) ?? process.env.WBS_RECEIVER_BASE_URL;
    if (!wbsBase) {
      logger.warn({ storeId }, 'product-meta-sync: no wbsBaseUrl configured');
      return { skipped: true, reason: 'no-wbs-url' };
    }

    // For upsert: include the product payload so WBS doesn't need to call back
    let productPayload: Record<string, unknown> | null = null;
    if (action === 'upsert') {
      // Note: currency lives on the Store, not the Product. WBS reads
      // currency from the store config separately (via wa-ordering settings).
      productPayload = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          price: true,
          description: true,
          images: { select: { url: true }, orderBy: { position: 'asc' }, take: 1 },
          status: true,
        },
      });
    }

    const res = await fetch(`${wbsBase}/api/internal/inngest-receiver`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inngest-Receiver-Secret': process.env.INNGEST_RECEIVER_SECRET ?? '',
      },
      body: JSON.stringify({
        kind: 'product.synced',
        storeId,
        productId,
        action,
        product: productPayload,
      }),
    });

    if (!res.ok) {
      logger.error(
        { storeId, productId, status: res.status },
        'product-meta-sync: wbs receiver failed'
      );
      throw new Error(`wbs receiver returned ${res.status}`);
    }

    return { skipped: false, status: res.status };
  });
};

export const productMetaSyncFn: InngestFunction.Any = inngest.createFunction(
  {
    id: 'product-meta-sync',
    name: 'Product → Meta Catalog sync',
    retries: 3,
    triggers: [{ event: 'product.upserted' as any }],
  },
  productMetaSync as any
);

export const productMetaSyncDeleteFn: InngestFunction.Any = inngest.createFunction(
  {
    id: 'product-meta-sync-delete',
    name: 'Product delete → Meta Catalog',
    retries: 3,
    triggers: [{ event: 'product.deleted' as any }],
  },
  productMetaSync as any
);
