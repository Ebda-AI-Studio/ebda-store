import { MoneyError, type SyncSql } from './sync-sql';

/**
 * In-store barcode allocation on the StoreDO (Ruling BARCODE-DO-1): the twin of `barcode.service.ts` `allocateBarcodes`,
 * `generateMissingBarcodes` and `ensureBarcode`. The Postgres twin takes `pg_advisory_xact_lock(hashtext(store || ':barcode'))`
 * so two requests are never handed the same code; here the whole operation is ONE synchronous section of a single-threaded
 * actor, which is the same guarantee with no lock.
 *
 * EAN-13 in the GS1 in-store range (prefix 20): the next serial after the store's highest 20-prefixed code, over live and
 * deleted products and all variants of the store (like the Postgres query, which does not filter deleted rows).
 */
export const ALLOCATION_PREFIX = 20;
export const GENERATE_BATCH_MAX = 500;
const MAX_SERIAL = 9_999_999_999;

/** The EAN-13 check digit of the first 12 digits (same algorithm as `@ebda/shared` `makeInStoreEan13`). */
export function ean13CheckDigit(d12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}
export function inStoreEan13(serial: number): string {
  const d12 = `${ALLOCATION_PREFIX}${String(serial).padStart(10, '0')}`;
  return `${d12}${ean13CheckDigit(d12)}`;
}

// workerd caps a LIKE/GLOB pattern at 50 bytes, so "20 + 11 digits" is spelled as length + prefix + no non-digit
const IS_IN_STORE = (col: string) =>
  `(length(${col}) = 13 AND substr(${col}, 1, 2) = '20' AND ${col} NOT GLOB '*[^0-9]*')`;

function nextSerial(db: SyncSql, storeId: string): number {
  const rows = db.all(
    `SELECT max(CAST(substr(b, 3, 10) AS INTEGER)) AS m FROM (
       SELECT p.barcode AS b FROM products p WHERE p.store_id = ? AND ${IS_IN_STORE('p.barcode')}
       UNION ALL
       SELECT v.barcode FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE p.store_id = ? AND ${IS_IN_STORE('v.barcode')}
     )`,
    [storeId, storeId]
  );
  return Number(rows[0]?.m ?? 0) + 1;
}

function allocate(db: SyncSql, storeId: string, count: number): string[] {
  if (count <= 0) return [];
  const start = nextSerial(db, storeId);
  if (start + count - 1 > MAX_SERIAL)
    throw new MoneyError('BARCODE_RANGE_FULL', 'No more in-store barcodes can be generated', 409);
  return Array.from({ length: count }, (_, i) => inStoreEan13(start + i));
}

export interface GenerateResult {
  products: number;
  variants: number;
  remaining: number;
}

const NO_BARCODE_PRODUCT =
  'p.store_id = ? AND p.deleted_at IS NULL AND p.barcode IS NULL AND NOT EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id)';
const NO_BARCODE_VARIANT = 'v.barcode IS NULL AND p.store_id = ? AND p.deleted_at IS NULL';

/** Fill missing barcodes for existing items: at most GENERATE_BATCH_MAX per call (`remaining` > 0 = call again). */
export function generateMissingBarcodes(
  db: SyncSql,
  storeId: string,
  limit: number
): GenerateResult {
  const take = Math.min(Math.max(1, Math.floor(limit) || GENERATE_BATCH_MAX), GENERATE_BATCH_MAX);
  return db.transactionSync(() => {
    const products = db.all(
      `SELECT p.id FROM products p WHERE ${NO_BARCODE_PRODUCT} ORDER BY p.created_at ASC, p.id ASC LIMIT ?`,
      [storeId, take]
    );
    const variants = db.all(
      `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE ${NO_BARCODE_VARIANT}
         ORDER BY v.created_at ASC, v.id ASC LIMIT ?`,
      [storeId, take - products.length]
    );
    const total = products.length + variants.length;
    if (total === 0) return { products: 0, variants: 0, remaining: 0 };
    const codes = allocate(db, storeId, total);
    const now = Date.now();
    let i = 0;
    for (const p of products)
      db.run(
        'UPDATE products SET barcode = ?, updated_at = ? WHERE id = ? AND store_id = ? AND barcode IS NULL',
        [codes[i++], now, p.id, storeId]
      );
    for (const v of variants)
      db.run(
        'UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ? AND barcode IS NULL',
        [codes[i++], now, v.id]
      );
    const rp = db.all(`SELECT count(*) AS n FROM products p WHERE ${NO_BARCODE_PRODUCT}`, [
      storeId,
    ])[0];
    const rv = db.all(
      `SELECT count(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id WHERE ${NO_BARCODE_VARIANT}`,
      [storeId]
    )[0];
    return {
      products: products.length,
      variants: variants.length,
      remaining: Number(rp?.n ?? 0) + Number(rv?.n ?? 0),
    };
  });
}

/** One fresh barcode for a just-created product or variant that has none; null when it already has one (or is not the store's). */
export function ensureBarcode(
  db: SyncSql,
  storeId: string,
  target: { productId?: string; variantId?: string }
): { code: string | null } {
  return db.transactionSync(() => {
    const [code] = allocate(db, storeId, 1);
    const now = Date.now();
    if (target.variantId) {
      const r = db.run(
        `UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ? AND barcode IS NULL
           AND product_id IN (SELECT id FROM products WHERE store_id = ?)`,
        [code, now, target.variantId, storeId]
      );
      return { code: r.changes ? code : null };
    }
    if (!target.productId) throw new MoneyError('BAD_ARGS', 'productId or variantId', 400);
    const r = db.run(
      'UPDATE products SET barcode = ?, updated_at = ? WHERE id = ? AND store_id = ? AND barcode IS NULL',
      [code, now, target.productId, storeId]
    );
    return { code: r.changes ? code : null };
  });
}
