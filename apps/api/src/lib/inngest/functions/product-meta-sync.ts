import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import { prisma as defaultPrisma, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { featureService } from '../../../services/feature.service';

interface SyncArgs {
  // The upsert emitter (product.service) sends `op: 'create'|'update'`, NOT `action`.
  // One handler serves both product.upserted and product.deleted, so `action` is
  // derived from the EVENT NAME below — reading event.data.action made it undefined
  // on every upsert, so FWB POSTed action:undefined and WBS rejected it with 400
  // "missing required fields" (product→Meta sync silently failed on every save).
  event: {
    name?: string;
    data: {
      storeId: string;
      productId: string;
      op?: 'create' | 'update';
      action?: 'upsert' | 'delete';
    };
  };
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
 *   - store does not have the `whatsapp` feature enabled (plan gate —
 *     part of the 2026-05-27 cross-product gating; merchant on Starter
 *     plan with no whatsapp override should not sync to Meta)
 *   - store has no meta_catalog_id (native catalog not configured)
 *   - store has no wbsBaseUrl in settings (WBS not wired for this store)
 */
export const productMetaSync = async ({
  event,
  step,
  prisma = defaultPrisma,
}: SyncArgs): Promise<{ skipped: boolean; reason?: string; status?: number }> => {
  const { storeId, productId } = event.data;
  // Derive the WBS-contract action from the event name (the upsert event only
  // carries `op`, never `action`). product.deleted → 'delete'; everything else
  // (product.upserted for create/update) → 'upsert'.
  const action: 'upsert' | 'delete' =
    event.name === 'product.deleted' || event.data.action === 'delete' ? 'delete' : 'upsert';

  return step.run('fanout-to-wbs', async () => {
    // Feature gate first — cheapest check + clearest signal in logs when
    // a merchant is on a plan that doesn't include WhatsApp (or the
    // super-admin has revoked the override).
    const whatsappEnabled = await featureService.isFeatureEnabled(storeId, 'whatsapp');
    if (!whatsappEnabled) {
      logger.info(
        { storeId, productId, action },
        'product-meta-sync: whatsapp feature not enabled for this store, skipping'
      );
      return { skipped: true, reason: 'feature-not-enabled' };
    }

    // All DB reads (Store, Product) run inside runInTenantContext so FORCE RLS
    // policies see the correct store GUC. This function is triggered by
    // product events which fire outside the HTTP tenant context.
    return runInTenantContext(storeId, async () => {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          metaCatalogId: true,
          settings: true,
          // For the Meta catalog feed fields (link / brand / currency) — FWB owns
          // the storefront-URL truth; WBS just maps what we send.
          name: true,
          slug: true,
          domain: true,
          currency: true,
        },
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

      // For upsert: include the product payload so WBS doesn't need to call back.
      // Enrich with the Meta feed fields WBS can't derive on its own:
      //   - link     : the product's storefront URL (custom domain, else platform/slug)
      //   - brand    : the store name
      //   - currency : lives on the Store, not the Product
      let productPayload: Record<string, unknown> | null = null;
      if (action === 'upsert') {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: {
            id: true,
            name: true,
            nameAr: true,
            slug: true,
            price: true,
            description: true,
            images: { select: { url: true }, orderBy: { position: 'asc' }, take: 1 },
            status: true,
          },
        });
        if (product) {
          const storeBase = store.domain
            ? `https://${store.domain}`
            : `https://store.forcemediakw.com/${store.slug}`;
          productPayload = {
            ...product,
            link: `${storeBase}/products/${product.slug}`,
            brand: store.name,
            currency: store.currency,
          };
        }
      }

      // WBS mounts external routes at /api/v1/external (server.js), so the
      // receiver lives at /api/v1/external/internal/inngest-receiver.
      const res = await fetch(`${wbsBase}/api/v1/external/internal/inngest-receiver`, {
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
