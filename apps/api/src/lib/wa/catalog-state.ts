/**
 * `catalog.product_upserted` / `catalog.product_deleted` (contract section 4) on ANY product or
 * variant write: price, stock, availability, gold reprice, bulk import, soft delete. Like the plan
 * events this hangs off the ONE database observer (lib/wa/observers.ts), so no write path (a
 * service, a job, the repricer, an import) can be missed; Ebda Chat then reads the details over
 * the bridge.
 */
import { ambientScope, type ModelWriteEvent } from '@ebda/database';
import { sendEventAfterCommit } from '../inngest/send-after-commit';
import logger from '../logger';
import { hasWhatsAppLinkRow } from './link';

export const CATALOG_CHANGED_EVENT = 'catalog/changed';

/** More ids than this in one write is sent as "the whole catalog of the store". */
export const MAX_IDS_PER_EVENT = 200;

export interface CatalogChange {
  storeId: string;
  /** null = unknown / many: the job resyncs the store's whole catalog. */
  productIds: string[] | null;
}

const CATALOG_MODELS = new Set(['Product', 'ProductVariant', 'WarehouseStock']);
const WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function idsOf(filter: unknown): string[] | null {
  const direct = str(filter);
  if (direct) return [direct];
  if (filter && typeof filter === 'object') {
    const inList = (filter as { in?: unknown }).in;
    if (Array.isArray(inList) && inList.every(x => typeof x === 'string')) {
      return inList.length <= MAX_IDS_PER_EVENT ? (inList as string[]) : null;
    }
  }
  return null;
}

/** Pure: which store/products a database write touched, or null when it is not a catalog write. */
export function catalogChangeFrom(
  e: ModelWriteEvent,
  ambientStoreId?: string
): CatalogChange | null {
  if (!CATALOG_MODELS.has(e.model) || !WRITES.has(e.operation)) return null;
  const args = (e.args ?? {}) as {
    where?: Record<string, unknown>;
    data?: Record<string, unknown> | Array<Record<string, unknown>>;
    create?: Record<string, unknown>;
  };
  const result = (e.result ?? {}) as Record<string, unknown>;
  const data = Array.isArray(args.data) ? undefined : args.data;
  const storeId =
    str(args.where?.storeId) ??
    str(data?.storeId) ??
    str(args.create?.storeId) ??
    str(result.storeId) ??
    ambientStoreId ??
    null;
  if (!storeId) return null;

  let productIds: string[] | null = null;
  if (e.model === 'Product') {
    productIds = idsOf(args.where?.id) ?? (str(result.id) ? [str(result.id) as string] : null);
  } else {
    // ProductVariant / WarehouseStock carry the product id
    const pid =
      str(args.where?.productId) ??
      str(data?.productId) ??
      str(args.create?.productId) ??
      str(result.productId);
    productIds = pid ? [pid] : idsOf((args.where?.productId as unknown) ?? null);
  }
  return { storeId, productIds };
}

// A tiny per-isolate cache of "does Ebda Chat know this store": most stores never link, and a
// bulk import must not enqueue a job per product for them. A stale `false` for at most the TTL only
// delays the first catalog event of a store that just linked; the link flow resyncs the catalog.
const KNOWN_TTL_MS = 30_000;
const known = new Map<string, { at: number; value: boolean }>();
export function clearKnownStoreCache(): void {
  known.clear();
}
async function storeKnown(storeId: string): Promise<boolean> {
  const hit = known.get(storeId);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.value;
  const value = await hasWhatsAppLinkRow(storeId);
  known.set(storeId, { at: Date.now(), value });
  return value;
}

/**
 * Never throws: it is called from inside stock and price writes (raw-SQL writers call it directly)
 * and a notification problem must not fail the write. An unreadable "known" lookup fails OPEN
 * (the event is sent; the job checks the link again).
 */
export async function notifyCatalogChanged(change: CatalogChange): Promise<void> {
  try {
    let isKnown = true;
    try {
      isKnown = await storeKnown(change.storeId);
    } catch (err) {
      logger.warn(
        { err, storeId: change.storeId },
        '[wa] known-store lookup failed, sending anyway'
      );
    }
    if (!isKnown) return;
    await sendEventAfterCommit(
      'wa-catalog-changed',
      {
        name: CATALOG_CHANGED_EVENT,
        data: { storeId: change.storeId, productIds: change.productIds },
      },
      { ifUnhookable: 'send' }
    );
  } catch (err) {
    logger.warn({ err, storeId: change.storeId }, '[wa] catalog change notify failed');
  }
}

export function onCatalogWrite(e: ModelWriteEvent): void {
  const change = catalogChangeFrom(e, ambientScope().storeId);
  if (!change) return;
  void notifyCatalogChanged(change).catch(err =>
    logger.warn({ err, storeId: change.storeId }, '[wa] catalog change notify failed')
  );
}
