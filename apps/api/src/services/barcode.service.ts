/**
 * Product and variant barcodes (BARCODE-1).
 *
 *  - `parseBarcodeOrThrow`: what a merchant typed or scanned (EAN-13 / UPC-A with a valid check
 *    digit, or Code 128 text) or a 422 `BARCODE_INVALID`.
 *  - `assertBarcodeAvailable`: store-wide uniqueness across products AND variants (a 409
 *    `BARCODE_IN_USE` naming who holds it). The two partial unique indexes are the DB backstop
 *    (migration 20261107000270); variants carry no store_id, so the cross-table rule lives here.
 *  - `allocateBarcodes`: EAN-13 in the GS1 in-store range (prefix 20), next serials after the
 *    store's highest 20-prefixed code, taken under `pg_advisory_xact_lock(hashtext(store||':barcode'))`
 *    so two requests can never be handed the same code. The lock lives to the end of the
 *    transaction: callers run inside the request transaction (tenantContext) or `withStore`.
 *  - `generateMissingBarcodes`: fill every live product WITHOUT variants and every variant that
 *    has none (bounded per call).
 *
 * Cloudflare move: this is the only place that allocates; on StoreDO the single-threaded actor
 * replaces the advisory lock and `allocateBarcodes` keeps its signature.
 */
import { prisma, withStore } from '@ebda/database';
import { makeInStoreEan13, parseBarcodeInput } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { featureService } from './feature.service';
import logger from '../lib/logger';
import { withSavepoint } from '../lib/savepoint';
import { storeDb, storeMoney } from '../lib/repo-factory';

type Db = Pick<typeof prisma, '$queryRaw' | '$executeRaw'> & {
  product: typeof prisma.product;
  productVariant: typeof prisma.productVariant;
};

/** The in-store prefix we allocate from. 21-29 stay free for merchants who number their own stock. */
export const ALLOCATION_PREFIX = 20;
export const GENERATE_BATCH_MAX = 500;

export function parseBarcodeOrThrow(raw: string): string {
  const parsed = parseBarcodeInput(raw);
  if (parsed.ok) return parsed.value;
  throw new AppError(422, 'BARCODE_INVALID', 'Barcode is not valid', { reason: parsed.reason });
}

export async function lockStoreBarcodes(db: Db, storeId: string): Promise<void> {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${storeId + ':barcode'}))`;
}

export type BarcodeOwner = {
  type: 'product' | 'variant';
  id: string;
  productId: string;
  name: string;
};

/** Who already holds `barcode` in this store (live products and their variants), if anyone. */
/** A UPC-A and its EAN-13 form (leading 0) are the same physical code: look up both spellings. */
export function barcodeSpellings(barcode: string): string[] {
  if (/^\d{12}$/.test(barcode)) return [barcode, `0${barcode}`];
  if (/^0\d{12}$/.test(barcode)) return [barcode, barcode.slice(1)];
  return [barcode];
}

export async function findBarcodeOwner(
  storeId: string,
  barcode: string,
  db: Db = prisma as unknown as Db
): Promise<BarcodeOwner | null> {
  const spellings = barcodeSpellings(barcode);
  const product = await db.product.findFirst({
    where: { storeId, barcode: { in: spellings }, deletedAt: null },
    select: { id: true, name: true },
  });
  if (product)
    return { type: 'product', id: product.id, productId: product.id, name: product.name };
  const variant = await db.productVariant.findFirst({
    where: { barcode: { in: spellings }, product: { storeId, deletedAt: null } },
    select: { id: true, title: true, productId: true, product: { select: { name: true } } },
  });
  return variant
    ? {
        type: 'variant',
        id: variant.id,
        productId: variant.productId,
        name: `${variant.product.name} / ${variant.title}`,
      }
    : null;
}

/** 409 unless `barcode` is free, or already held by `except` (the row being saved). */
export async function assertBarcodeAvailable(
  storeId: string,
  barcode: string,
  except: { productId?: string; variantId?: string } = {},
  db?: Db
): Promise<void> {
  // A store on its Durable Object reads its own rows; the single-threaded actor and the partial unique indexes replace the
  // advisory lock (Ruling BARCODE-DO-1).
  const onDo = !db && !!(await storeMoney(storeId));
  const d = db ?? (onDo ? ((await storeDb(storeId)) as unknown as Db) : (prisma as unknown as Db));
  if (!onDo) await lockStoreBarcodes(d, storeId);
  const owner = await findBarcodeOwner(storeId, barcode, d);
  if (!owner) return;
  if (owner.type === 'product' && owner.id === except.productId) return;
  if (owner.type === 'variant' && owner.id === except.variantId) return;
  throw new AppError(409, 'BARCODE_IN_USE', 'This barcode already belongs to another item', {
    ownerType: owner.type,
    ownerId: owner.id,
    ownerName: owner.name,
  });
}

/** `count` fresh EAN-13 codes (consecutive serials) for the store. */
export async function allocateBarcodes(
  storeId: string,
  count: number,
  db: Db = prisma as unknown as Db
): Promise<string[]> {
  if (count <= 0) return [];
  await lockStoreBarcodes(db, storeId);
  const rows = await db.$queryRaw<Array<{ m: bigint | null }>>`
    SELECT max(substr(b, 3, 10)::bigint) AS m FROM (
      SELECT p.barcode AS b FROM products p
        WHERE p.store_id = ${storeId} AND p.barcode ~ '^20[0-9]{11}$'
      UNION ALL
      SELECT v.barcode FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.store_id = ${storeId} AND v.barcode ~ '^20[0-9]{11}$'
    ) t`;
  const start = Number(rows[0]?.m ?? 0n) + 1;
  if (start + count - 1 > 9_999_999_999) {
    throw new AppError(409, 'BARCODE_RANGE_FULL', 'No more in-store barcodes can be generated');
  }
  return Array.from({ length: count }, (_, i) => makeInStoreEan13(ALLOCATION_PREFIX, start + i));
}

async function barcodeFeatureOn(storeId: string): Promise<boolean> {
  try {
    return await featureService.isFeatureEnabled(storeId, 'inventory.barcode');
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : 'unknown' },
      '[BARCODE] feature check failed'
    );
    return false;
  }
}

/**
 * Give a just-created product (no variants) or variant a barcode when the store has the
 * `inventory.barcode` feature and the row has none. Never blocks the create: a failure is logged
 * and the row stays barcode-less (the merchant can generate it from the labels page).
 */
export async function ensureBarcode(
  storeId: string,
  target: { productId: string } | { variantId: string },
  db: Db = prisma as unknown as Db
): Promise<string | null> {
  try {
    if (!(await barcodeFeatureOn(storeId))) return null;
    // A store on its Durable Object allocates and writes in ONE section there (Ruling BARCODE-DO-1).
    const money = await storeMoney(storeId);
    if (money) return (await money.barcodeEnsure(target)).code;
    return await withSavepoint(async () => {
      const [code] = await allocateBarcodes(storeId, 1, db);
      if ('variantId' in target) {
        const { count } = await db.productVariant.updateMany({
          where: { id: target.variantId, barcode: null, product: { storeId } },
          data: { barcode: code },
        });
        return count ? code : null;
      }
      const { count } = await db.product.updateMany({
        where: { id: target.productId, storeId, barcode: null },
        data: { barcode: code },
      });
      return count ? code : null;
    });
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : 'unknown' },
      '[BARCODE] auto-generate skipped'
    );
    return null;
  }
}

export type GenerateResult = { products: number; variants: number; remaining: number };

/** Fill missing barcodes for existing items: at most GENERATE_BATCH_MAX per call (`remaining` > 0 = call again). */
export async function generateMissingBarcodes(
  storeId: string,
  limit: number = GENERATE_BATCH_MAX
): Promise<GenerateResult> {
  const take = Math.min(Math.max(1, limit), GENERATE_BATCH_MAX);
  const money = await storeMoney(storeId);
  if (money) return money.barcodeFill({ limit: take });
  return withStore(storeId, async tx => {
    const db = tx as unknown as Db;
    // Lock BEFORE choosing rows: two concurrent calls must not pick the same barcode-less rows.
    await lockStoreBarcodes(db, storeId);
    const products = await tx.product.findMany({
      where: { storeId, deletedAt: null, barcode: null, variants: { none: {} } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take,
    });
    const variants = await tx.productVariant.findMany({
      where: { barcode: null, product: { storeId, deletedAt: null } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take - products.length,
    });
    const total = products.length + variants.length;
    if (total === 0) return { products: 0, variants: 0, remaining: 0 };
    const codes = await allocateBarcodes(storeId, total, db);
    let i = 0;
    for (const p of products) {
      await tx.product.updateMany({
        where: { id: p.id, storeId, barcode: null },
        data: { barcode: codes[i++] },
      });
    }
    for (const v of variants) {
      await tx.productVariant.updateMany({
        where: { id: v.id, barcode: null },
        data: { barcode: codes[i++] },
      });
    }
    const remainingProducts = await tx.product.count({
      where: { storeId, deletedAt: null, barcode: null, variants: { none: {} } },
    });
    const remainingVariants = await tx.productVariant.count({
      where: { barcode: null, product: { storeId, deletedAt: null } },
    });
    return {
      products: products.length,
      variants: variants.length,
      remaining: remainingProducts + remainingVariants,
    };
  });
}

/** After a bulk import: when the store has `inventory.barcode`, fill every barcode-less item (bounded loop). */
export async function fillMissingAfterImport(storeId: string): Promise<void> {
  try {
    if (!(await barcodeFeatureOn(storeId))) return;
    for (let i = 0; i < 20; i++) {
      const r = await generateMissingBarcodes(storeId);
      if (r.remaining === 0 || r.products + r.variants === 0) break;
    }
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : 'unknown' },
      '[BARCODE] post-import auto-generate skipped'
    );
  }
}
