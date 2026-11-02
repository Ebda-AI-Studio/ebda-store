// Product pricing edits on the StoreDO (INFRA-CF-1 PR D2b-5, Ruling CF-LAST-1): `GoldRateService.setProductPricing`,
// `asRepricer` and `bulkSwitchMode`. The Postgres versions run under `pg_advisory_xact_lock(gold-rate:<store>)` and re-price
// inside the same transaction; here the single thread is that lock and the whole edit (spec write, variant overrides, re-price
// with `do_flags.gold_reprice` on) is ONE `transactionSync` section. The audit row is the Worker's, after the commit.
import { GOLD_KARATS, loadCurrentRates, loadGoldSettings } from './gold';
import type { GoldKarat } from './gold';
import { GOLD_CATALOGUE_CAP, repriceGoldStore } from './gold-rates';
import { MoneyError, type SyncSql } from './sync-sql';

export interface ProductPricingInput {
  pricingMode: 'fixed' | 'gold_rate';
  karat?: GoldKarat | null;
  weightMg?: number | null;
  makingChargeType?: 'fixed' | 'per_gram' | null;
  makingChargeValue?: number | null;
  marginBps?: number;
}
export interface VariantPricingInput {
  id: string;
  pricingMode: 'fixed' | 'gold_rate' | null;
  karat?: GoldKarat | null;
  weightMg?: number | null;
  makingChargeType?: 'fixed' | 'per_gram' | null;
  makingChargeValue?: number | null;
  marginBps?: number | null;
}

const err = (code: string, message: string, status = 409, meta?: Record<string, unknown>) =>
  new MoneyError(code, message, status, meta);
const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const nul = <T>(v: T | null | undefined) => (v === undefined ? null : v);

function setFlag(db: SyncSql, on: boolean): void {
  db.run(
    `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    [on ? 1 : 0]
  );
}

/** The Worker parsed this with the shared zod schema; the DO re-checks what a wrong value would corrupt (fail closed). */
function checkProductInput(p: ProductPricingInput): void {
  const bad = (m: string) => err('VALIDATION_ERROR', `pricing input: ${m}`, 400);
  if (p?.pricingMode !== 'fixed' && p?.pricingMode !== 'gold_rate') throw bad('pricingMode');
  if (p.pricingMode === 'fixed') return;
  if (!(GOLD_KARATS as readonly number[]).includes(p.karat as number)) throw bad('karat');
  if (!isInt(p.weightMg, 1, 1_000_000) || p.weightMg % 10 !== 0) throw bad('weightMg');
  if (p.makingChargeType !== 'fixed' && p.makingChargeType !== 'per_gram')
    throw bad('makingChargeType');
  if (!isInt(p.makingChargeValue, 0, 2_147_483_647)) throw bad('makingChargeValue');
  if (p.marginBps !== undefined && !isInt(p.marginBps, -5_000, 10_000)) throw bad('marginBps');
}
function checkVariantInput(v: VariantPricingInput): void {
  const bad = (m: string) => err('VALIDATION_ERROR', `variant pricing input: ${m}`, 400);
  if (typeof v?.id !== 'string' || v.id.length === 0) throw bad('id');
  if (v.pricingMode !== null && v.pricingMode !== 'fixed' && v.pricingMode !== 'gold_rate')
    throw bad('pricingMode');
  if (v.karat != null && !(GOLD_KARATS as readonly number[]).includes(v.karat)) throw bad('karat');
  if (v.weightMg != null && (!isInt(v.weightMg, 1, 1_000_000) || v.weightMg % 10 !== 0))
    throw bad('weightMg');
  if (
    v.makingChargeType != null &&
    v.makingChargeType !== 'fixed' &&
    v.makingChargeType !== 'per_gram'
  )
    throw bad('makingChargeType');
  if (v.makingChargeValue != null && !isInt(v.makingChargeValue, 0, 2_147_483_647))
    throw bad('makingChargeValue');
  if (v.marginBps != null && !isInt(v.marginBps, -5_000, 10_000)) throw bad('marginBps');
}

function currentLookup(db: SyncSql, storeId: string) {
  const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
  for (const [k, r] of loadCurrentRates(db, storeId, GOLD_KARATS))
    lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
  return lookup;
}

export interface PricingResult {
  pricingMode: 'fixed' | 'gold_rate';
  price: number;
  /** the mode before the edit, for the Worker's audit row */
  from: string;
  /** set when the edit froze a gold price as the fixed price */
  frozenPrice?: number;
}

function applyProductPricing(
  db: SyncSql,
  storeId: string,
  productId: string,
  product: ProductPricingInput,
  variantInputs: VariantPricingInput[],
  now: number
): PricingResult {
  const existing = db.all(
    'SELECT id, pricing_mode FROM products WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
    [productId, storeId]
  )[0];
  if (!existing) throw err('NOT_FOUND', 'Product not found', 404);
  const variants = db.all('SELECT id, price FROM product_variants WHERE product_id = ?', [
    productId,
  ]);
  const variantIds = new Set(variants.map(v => v.id as string));
  for (const v of variantInputs)
    if (!variantIds.has(v.id)) throw err('NOT_FOUND', 'Variant not found', 404);
  // Ruling B5-36: a fixed variant under a gold product keeps ITS OWN price (a priceless one could only ratchet down)
  if (product.pricingMode !== 'fixed') {
    const priceById = new Map(variants.map(v => [v.id as string, v.price]));
    const unpriced = variantInputs.filter(
      v => v.pricingMode === 'fixed' && priceById.get(v.id) == null
    );
    if (unpriced.length > 0)
      throw err(
        'GOLD_VARIANT_NEEDS_PRICE',
        'A fixed-price variant under a gold product needs its own price first',
        409,
        {
          variantIds: unpriced.map(v => v.id),
          messageAr: 'المتغيّر ده بسعر ثابت ومحتاج سعر خاص بيه الأول.',
        }
      );
  }
  const settings = loadGoldSettings(db, storeId);
  const before = existing.pricing_mode as string;

  setFlag(db, true);
  try {
    if (product.pricingMode === 'fixed') {
      // gold -> fixed: freeze the last computed price (the column already holds it); variants too
      db.run(
        "UPDATE products SET pricing_mode = 'fixed', updated_at = ? WHERE id = ? AND store_id = ?",
        [now, productId, storeId]
      );
      db.run(
        'UPDATE product_variants SET pricing_mode = NULL, updated_at = ? WHERE product_id = ?',
        [now, productId]
      );
    } else {
      if (before !== 'gold_rate') {
        // Ruling B5-13: the catalogue cap is enforced where a product BECOMES gold, not only by the repricer
        const goldCount = Number(
          db.all(
            "SELECT count(*) AS n FROM products WHERE store_id = ? AND pricing_mode = 'gold_rate' AND deleted_at IS NULL",
            [storeId]
          )[0].n
        );
        if (goldCount >= GOLD_CATALOGUE_CAP)
          throw err(
            'GOLD_CATALOGUE_TOO_LARGE',
            `A store can hold at most ${GOLD_CATALOGUE_CAP} gold-priced products`
          );
      }
      const bundled = Number(
        db.all('SELECT count(*) AS n FROM bundle_items WHERE product_id = ?', [productId])[0].n
      );
      if (bundled > 0)
        throw err(
          'GOLD_IN_BUNDLE',
          'A product in a bundle cannot be priced by the gold rate',
          409,
          {
            messageAr: 'مينفعش تسعّر منتج جوه باقة بسعر الدهب.',
          }
        );
      const tiers = Number(
        db.all(
          'SELECT count(*) AS n FROM product_price_tiers WHERE store_id = ? AND product_id = ?',
          [storeId, productId]
        )[0].n
      );
      if (tiers > 0)
        throw err(
          'GOLD_NO_PRICE_TIERS',
          'A product with fixed-price wholesale tiers cannot be priced by the gold rate',
          409,
          { messageAr: 'امسح شرائح الأسعار الثابتة الأول وبعدين سعّر المنتج بسعر الدهب.' }
        );
      const karatsUsed = new Set<GoldKarat>([product.karat as GoldKarat]);
      for (const v of variantInputs)
        if (v.karat != null && v.pricingMode !== 'fixed') karatsUsed.add(v.karat);
      const rates = loadCurrentRates(db, storeId, [...karatsUsed]);
      const missing = [...karatsUsed].filter(k => !rates.has(k));
      if (missing.length > 0)
        throw err(
          'GOLD_RATE_MISSING',
          `Set today's ${missing.join('k, ')}k rate before pricing a product by gold`,
          409,
          {
            karats: missing,
            messageAr: 'سجّل سعر الجرام النهارده الأول وبعدين اختار التسعير بالدهب.',
          }
        );
      db.run(
        `UPDATE products SET pricing_mode = 'gold_rate', gold_karat = ?, gold_weight_mg = ?, making_charge_type = ?,
           making_charge_value = ?, gold_margin_bps = ?, compare_at_price = NULL, discount_type = NULL, discount_value = NULL,
           updated_at = ? WHERE id = ? AND store_id = ?`,
        [
          product.karat!,
          product.weightMg!,
          product.makingChargeType!,
          product.makingChargeValue!,
          product.marginBps ?? 0,
          now,
          productId,
          storeId,
        ]
      );
      // every variant: clear compare-at (it inherits gold), then apply the explicit overrides
      db.run(
        'UPDATE product_variants SET compare_at_price = NULL, updated_at = ? WHERE product_id = ?',
        [now, productId]
      );
      for (const v of variantInputs)
        db.run(
          `UPDATE product_variants SET pricing_mode = ?, gold_karat = ?, gold_weight_mg = ?, making_charge_type = ?,
             making_charge_value = ?, gold_margin_bps = ?, ${v.pricingMode === 'gold_rate' ? 'compare_at_price = NULL,' : ''}
             updated_at = ? WHERE id = ? AND product_id = ?`,
          [
            nul(v.pricingMode),
            nul(v.karat),
            nul(v.weightMg),
            nul(v.makingChargeType),
            nul(v.makingChargeValue),
            nul(v.marginBps),
            now,
            v.id,
            productId,
          ]
        );
      repriceGoldStore(
        db,
        storeId,
        null,
        currentLookup(db, storeId),
        settings.roundingStep,
        now,
        productId
      );
    }
  } finally {
    setFlag(db, false);
  }
  const after = db.all('SELECT pricing_mode, price FROM products WHERE id = ? AND store_id = ?', [
    productId,
    storeId,
  ])[0];
  const price = Number(after.price);
  return {
    pricingMode: after.pricing_mode as 'fixed' | 'gold_rate',
    price,
    from: before,
    ...(product.pricingMode === 'fixed' ? { frozenPrice: price } : {}),
  };
}

/** `GoldRateService.setProductPricing`: mode + spec + variant overrides + re-price, ONE section. */
export function setGoldProductPricing(
  db: SyncSql,
  storeId: string,
  productId: string,
  input: { product: ProductPricingInput; variants?: VariantPricingInput[] },
  opts: { now?: number } = {}
): PricingResult {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  checkProductInput(input?.product);
  const variants = input.variants ?? [];
  if (!Array.isArray(variants)) throw err('VALIDATION_ERROR', 'variants', 400);
  variants.forEach(checkVariantInput);
  const now = opts.now ?? Date.now();
  return db.transactionSync(() =>
    applyProductPricing(db, storeId, productId, input.product, variants, now)
  );
}

/**
 * `GoldRateService.bulkSwitchMode`: every product is its own nested section (a savepoint), so a refused product is SKIPPED with
 * its code and leaves nothing, exactly like the per-product Postgres transaction; anything that is not a refusal (a 5xx) aborts
 * the call. At most 500 ids. A stored spec the edge schema would refuse aborts the call (Postgres: the ZodError escapes).
 */
export function bulkSwitchGoldMode(
  db: SyncSql,
  storeId: string,
  ids: string[],
  mode: 'fixed' | 'gold_rate',
  opts: { now?: number } = {}
): { switched: string[]; skipped: Array<{ id: string; reason: string }> } {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  if (mode !== 'fixed' && mode !== 'gold_rate') throw err('VALIDATION_ERROR', 'mode', 400);
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string'))
    throw err('VALIDATION_ERROR', 'ids', 400);
  const unique = [...new Set(ids)].slice(0, 500);
  const now = opts.now ?? Date.now();
  return db.transactionSync(() => {
    const rows = unique.length
      ? db.all(
          `SELECT id, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps
             FROM products WHERE store_id = ? AND deleted_at IS NULL AND id IN (${unique.map(() => '?').join(',')})`,
          [storeId, ...unique]
        )
      : [];
    const byId = new Map(rows.map(r => [r.id as string, r]));
    const switched: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of unique) if (!byId.has(id)) skipped.push({ id, reason: 'NOT_FOUND' });
    for (const id of unique) {
      const r = byId.get(id);
      if (!r) continue;
      if (r.pricing_mode === mode) {
        skipped.push({ id, reason: 'ALREADY' });
        continue;
      }
      let product: ProductPricingInput;
      if (mode === 'fixed') product = { pricingMode: 'fixed' };
      else {
        if (
          r.gold_karat == null ||
          r.gold_weight_mg == null ||
          r.making_charge_type == null ||
          r.making_charge_value == null
        ) {
          skipped.push({ id, reason: 'SPEC_INCOMPLETE' });
          continue;
        }
        product = {
          pricingMode: 'gold_rate',
          karat: Number(r.gold_karat) as GoldKarat,
          weightMg: Number(r.gold_weight_mg),
          makingChargeType: r.making_charge_type as 'fixed' | 'per_gram',
          makingChargeValue: Number(r.making_charge_value),
          marginBps: Number(r.gold_margin_bps ?? 0),
        };
        checkProductInput(product); // outside the skip handler on purpose
      }
      try {
        db.transactionSync(() => applyProductPricing(db, storeId, id, product, [], now));
        switched.push(id);
      } catch (e) {
        if (e instanceof MoneyError && e.status < 500) skipped.push({ id, reason: e.code });
        else throw e;
      }
    }
    return { switched, skipped };
  });
}

export interface NewVariant {
  title: string;
  titleAr?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  inventory?: number;
  weight?: number | null;
  imageUrl?: string | null;
  position?: number;
}
/**
 * The asRepricer closure of `VariantService` (a variant INSERT under the repricer flag, then the re-price) as ONE section: the
 * variant is born priced, and a missing rate rolls the insert back (GOLD_RATE_MISSING 409), like the Postgres transaction.
 */
export function createGoldVariant(
  db: SyncSql,
  storeId: string,
  productId: string,
  v: NewVariant,
  optionValueIds: string[],
  opts: { now?: number; newId?: () => string } = {}
): { id: string } {
  if (!storeId) throw err('STORE_REQUIRED', 'storeId is required', 500);
  if (typeof v?.title !== 'string') throw err('VALIDATION_ERROR', 'title', 400);
  if (!Array.isArray(optionValueIds) || optionValueIds.some(o => typeof o !== 'string'))
    throw err('VALIDATION_ERROR', 'optionValueIds', 400);
  const now = opts.now ?? Date.now();
  const id = (opts.newId ?? (() => crypto.randomUUID()))();
  return db.transactionSync(() => {
    const p = db.all(
      'SELECT pricing_mode FROM products WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
      [productId, storeId]
    )[0];
    if (!p) throw err('NOT_FOUND', 'Product not found', 404);
    if (p.pricing_mode !== 'gold_rate')
      throw err('GOLD_PRODUCT_REQUIRED', 'the product is not priced by the gold rate', 409);
    const settings = loadGoldSettings(db, storeId);
    setFlag(db, true);
    try {
      db.run(
        `INSERT INTO product_variants (id, product_id, title, title_ar, sku, barcode, price, compare_at_price, cost_price, inventory, weight, image_url, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          productId,
          v.title,
          nul(v.titleAr),
          nul(v.sku),
          nul(v.barcode),
          nul(v.price),
          nul(v.compareAtPrice),
          nul(v.costPrice),
          v.inventory ?? 0,
          nul(v.weight),
          nul(v.imageUrl),
          v.position ?? 0,
          now,
          now,
        ]
      );
      for (const valueId of optionValueIds)
        db.run('INSERT INTO product_variant_options (variant_id, value_id) VALUES (?, ?)', [
          id,
          valueId,
        ]);
      repriceGoldStore(
        db,
        storeId,
        null,
        currentLookup(db, storeId),
        settings.roundingStep,
        now,
        productId
      );
    } finally {
      setFlag(db, false);
    }
    return { id };
  });
}
