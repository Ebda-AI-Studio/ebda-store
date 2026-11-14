import { MoneyError, type SyncSql } from './sync-sql';

/**
 * The CSV import orchestrator on the StoreDO (INFRA-CF-1 R3, Ruling IMPORT-DO-1). Port of the batch of
 * `BulkService.importProducts` (Phase 4) and `createVariantsForProductTx`: the product rows, their stock (opening stock and
 * its history row), categories / tags / images links and the variants of ONE batch are applied in ONE `transactionSync`
 * section, so a failing row rolls the whole batch back exactly like the Postgres interactive transaction. The Worker keeps
 * the parsing, validation, plan ceiling and the category / tag creation (Phases 1-3), and after the commit the work that is
 * not store data: slug redirects (platform) and gold specs (their own money section).
 *
 * Column names are a closed whitelist; the AI-field names are checked against the real `products` columns, so the Worker's
 * payload never reaches SQL as an identifier.
 */
export interface ImportVariantRow {
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  inventory?: number | null;
  weight?: number | null;
  imageUrl?: string | null;
  option1Name?: string;
  option1Value?: string;
  option2Name?: string;
  option2Value?: string;
  option3Name?: string;
  option3Value?: string;
}
export interface ImportRowPlan {
  rowIndex: number;
  existingId: string | null;
  existingSlug: string | null;
  slug: string;
  /** camelCase product fields exactly as `importProducts` builds `productFields` */
  fields: Record<string, unknown>;
  /** the AI-writable fields the row sets (non-empty), for the provenance stamp */
  imported: Record<string, unknown>;
  /** null = leave the links alone (a blank cell) */
  categoryIds: string[] | null;
  tagIds: string[] | null;
  imageUrls: string[] | null;
  variants: ImportVariantRow[] | null;
}

const FIELD_COLS: Record<string, string> = {
  name: 'name',
  nameAr: 'name_ar',
  slug: 'slug',
  description: 'description',
  descriptionAr: 'description_ar',
  price: 'price',
  compareAtPrice: 'compare_at_price',
  costPrice: 'cost_price',
  sku: 'sku',
  barcode: 'barcode',
  inventory: 'inventory',
  lowStockThreshold: 'low_stock_threshold',
  trackInventory: 'track_inventory',
  weight: 'weight',
  status: 'status',
  featured: 'featured',
  isNew: 'is_new',
  metaTitle: 'meta_title',
  metaTitleAr: 'meta_title_ar',
  metaDescription: 'meta_description',
  metaDescriptionAr: 'meta_description_ar',
  searchTerms: 'search_terms',
};
const BOOL_COLS = new Set(['track_inventory', 'featured', 'is_new']);
const STATUSES = new Set(['draft', 'active', 'archived']);
const snake = (s: string) => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

const fail = (rowIndex: number, e: unknown): never => {
  if (e instanceof MoneyError && /^row \d+:/.test(e.message)) throw e;
  const msg = e instanceof Error ? e.message : 'unknown error';
  const pinned = /FOREIGN KEY/i.test(msg)
    ? "a bundle pins one of this product's variants, so they cannot be replaced"
    : msg;
  throw new MoneyError('IMPORT_ROW_FAILED', `row ${rowIndex}: ${pinned}`, 409);
};

function stampHumanEdits(
  aiCols: Map<string, string>,
  current: Record<string, string>,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, string> {
  const next = { ...current };
  for (const [field, col] of aiCols) {
    if (!(field in incoming)) continue;
    const before = (stored[col] ?? '') as string;
    const after = (incoming[field] ?? '') as string;
    if (after === before) continue;
    if (String(after).trim() === '' && String(before).trim() === '') continue;
    next[field] = 'human';
  }
  return next;
}

function aiColumns(db: SyncSql, fields: string[]): Map<string, string> {
  const have = new Set(
    db.all("SELECT name FROM pragma_table_info('products')", []).map(r => r.name as string)
  );
  const out = new Map<string, string>();
  for (const f of fields) {
    if (!/^[a-z][A-Za-z]{0,40}$/.test(f) || !have.has(snake(f)))
      throw new MoneyError('BAD_ARGS', `unknown AI field ${f}`, 400);
    out.set(f, snake(f));
  }
  return out;
}

/** INV-AUDIT-3: an import's stock change is a movement row, like every other stock write (reason + actor). */
function importMovement(
  db: SyncSql,
  m: {
    storeId: string;
    productId: string;
    type: 'initial' | 'adjustment';
    previous: number;
    next: number;
    reason: string;
    userId: string | null;
    now: number;
  }
): void {
  if (m.previous === m.next) return;
  db.run(
    `INSERT INTO inventory_history (id, product_id, store_id, type, quantity, previous_stock, new_stock, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      m.productId,
      m.storeId,
      m.type,
      m.next - m.previous,
      m.previous,
      m.next,
      m.reason,
      m.userId,
      m.now,
    ]
  );
}

const dbVal = (col: string, v: unknown): unknown =>
  BOOL_COLS.has(col) ? (v ? 1 : 0) : v === undefined ? null : v;

/** Options, option values, variants and their junction rows for one product, replacing what it has. Returns the variants made. */
export function replaceProductVariants(
  db: SyncSql,
  a: {
    storeId: string;
    productId: string;
    variants: ImportVariantRow[];
    now: number;
    userId?: string | null;
  }
): number {
  const { productId, variants, now } = a;
  const userId = a.userId ?? null;
  if (variants.length === 0) return 0;
  const prior = db.all('SELECT id, name, name_ar FROM product_options WHERE product_id = ?', [
    productId,
  ]);
  const priorOptionAr = new Map(prior.map(o => [o.name as string, o.name_ar as string | null]));
  const priorValue = new Map<string, Record<string, unknown>>();
  for (const o of prior)
    for (const v of db.all(
      'SELECT value, value_ar, swatch_hex, swatch_image_url FROM product_option_values WHERE option_id = ?',
      [o.id]
    ))
      priorValue.set(`${o.name as string}|${v.value as string}`, v);

  const priorVariants = db.all(
    'SELECT sku, title, barcode FROM product_variants WHERE product_id = ? AND barcode IS NOT NULL',
    [productId]
  );
  const priorBarcodeBySku = new Map(
    priorVariants.filter(v => v.sku).map(v => [v.sku as string, v.barcode as string])
  );
  const priorBarcodeByTitle = new Map(
    priorVariants.map(v => [v.title as string, v.barcode as string])
  );
  const typed = new Set(variants.map(v => v.barcode).filter(Boolean) as string[]);
  const carried = new Set<string>();
  const carry = (sku: string | null, title: string): string | null => {
    const code = (sku ? priorBarcodeBySku.get(sku) : undefined) ?? priorBarcodeByTitle.get(title);
    if (!code || typed.has(code) || carried.has(code)) return null;
    carried.add(code);
    return code;
  };

  // the replaced variants take their units with them: record each as a movement to zero
  for (const old of db.all(
    'SELECT inventory FROM product_variants WHERE product_id = ? AND inventory <> 0',
    [productId]
  ))
    importMovement(db, {
      storeId: a.storeId,
      productId,
      type: 'adjustment',
      previous: old.inventory as number,
      next: 0,
      reason: 'Variant replaced by bulk import',
      userId,
      now,
    });
  db.run('DELETE FROM product_variants WHERE product_id = ?', [productId]);
  db.run('DELETE FROM product_options WHERE product_id = ?', [productId]);

  // collectOptions: per option name, distinct values in first-seen order
  const byName = new Map<string, string[]>();
  const order: string[] = [];
  for (const v of variants)
    for (const i of [1, 2, 3] as const) {
      const name = (v[`option${i}Name`] as string | undefined)?.toString().trim();
      const value = (v[`option${i}Value`] as string | undefined)?.toString().trim();
      if (!name || !value) continue;
      if (!byName.has(name)) {
        byName.set(name, []);
        order.push(name);
      }
      const vals = byName.get(name)!;
      if (!vals.includes(value)) vals.push(value);
    }
  const valueId = new Map<string, string>();
  order.forEach((name, oi) => {
    const optionId = crypto.randomUUID();
    db.run(
      'INSERT INTO product_options (id, product_id, name, name_ar, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [optionId, productId, name, priorOptionAr.get(name) ?? null, oi, now]
    );
    byName.get(name)!.forEach((value, vi) => {
      const kept = priorValue.get(`${name}|${value}`);
      const id = crypto.randomUUID();
      valueId.set(`${name}|${value}`, id);
      db.run(
        'INSERT INTO product_option_values (id, option_id, value, value_ar, swatch_hex, swatch_image_url, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          optionId,
          value,
          (kept?.value_ar as string) ?? null,
          (kept?.swatch_hex as string) ?? null,
          (kept?.swatch_image_url as string) ?? null,
          vi,
          now,
        ]
      );
    });
  });

  let made = 0;
  for (let vi = 0; vi < variants.length; vi++) {
    const v = variants[vi];
    const pairs: Array<{ name: string; value: string }> = [];
    for (const i of [1, 2, 3] as const) {
      const name = (v[`option${i}Name`] as string | undefined)?.toString().trim();
      const value = (v[`option${i}Value`] as string | undefined)?.toString().trim();
      if (name && value) pairs.push({ name, value });
    }
    if (pairs.length === 0) continue; // malformed variant row: skipped like Postgres
    const title = pairs.map(p => p.value).join(' / ');
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO product_variants (id, product_id, title, sku, barcode, price, compare_at_price, cost_price, inventory, weight, image_url, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        productId,
        title,
        v.sku || null,
        v.barcode || carry(v.sku || null, title),
        v.price ?? null,
        v.compareAtPrice ?? null,
        v.costPrice ?? null,
        v.inventory ?? 0,
        v.weight ?? null,
        v.imageUrl || null,
        vi,
        now,
        now,
      ]
    );
    importMovement(db, {
      storeId: a.storeId,
      productId,
      type: 'initial',
      previous: 0,
      next: v.inventory ?? 0,
      reason: 'Initial stock from bulk import',
      userId,
      now,
    });
    for (const p of pairs)
      db.run('INSERT INTO product_variant_options (variant_id, value_id) VALUES (?, ?)', [
        id,
        valueId.get(`${p.name}|${p.value}`)!,
      ]);
    made++;
  }
  db.run('UPDATE products SET has_variants = 1, updated_at = ? WHERE id = ? AND store_id = ?', [
    now,
    productId,
    a.storeId,
  ]);
  return made;
}

/**
 * One batch of the import. Everything commits together or nothing does. Returns the counts, the product id per row and the
 * slug renames (the Worker records the redirects after the commit).
 */
export function importProductsBatch(
  db: SyncSql,
  a: {
    storeId: string;
    rows: ImportRowPlan[];
    aiFields: string[];
    userId?: string | null;
    now?: number;
  }
): {
  created: number;
  updated: number;
  variantsCreated: number;
  products: Array<{ rowIndex: number; productId: string }>;
  renames: Array<{ from: string; to: string }>;
} {
  const now = a.now ?? Date.now();
  const aiCols = aiColumns(db, a.aiFields);
  return db.transactionSync(() => {
    const out = {
      created: 0,
      updated: 0,
      variantsCreated: 0,
      products: [] as Array<{ rowIndex: number; productId: string }>,
      renames: [] as Array<{ from: string; to: string }>,
    };
    for (const r of a.rows) {
      try {
        const cols: string[] = [];
        const vals: unknown[] = [];
        for (const [k, v] of Object.entries(r.fields)) {
          const col = FIELD_COLS[k];
          if (!col) throw new MoneyError('BAD_ARGS', `unknown product field ${k}`, 400);
          if (col === 'status' && !STATUSES.has(String(v)))
            throw new MoneyError('BAD_ARGS', `bad status ${String(v)}`, 400);
          cols.push(col);
          vals.push(dbVal(col, v));
        }
        let productId: string;
        if (r.existingId) {
          productId = r.existingId;
          const cur = db.all('SELECT * FROM products WHERE id = ? AND store_id = ?', [
            productId,
            a.storeId,
          ])[0];
          if (!cur) throw new MoneyError('PRODUCT_NOT_FOUND', 'product not found', 404);
          const sources = stampHumanEdits(
            aiCols,
            JSON.parse((cur.ai_field_sources as string) || '{}'),
            cur,
            r.imported
          );
          db.run(
            `UPDATE products SET ${cols.map(c => `${c} = ?`).join(', ')}, ai_field_sources = ?, updated_at = ? WHERE id = ? AND store_id = ?`,
            [...vals, JSON.stringify(sources), now, productId, a.storeId]
          );
          if (cols.includes('inventory'))
            importMovement(db, {
              storeId: a.storeId,
              productId,
              type: 'adjustment',
              previous: (cur.inventory as number | null) ?? 0,
              next: Number(r.fields.inventory ?? 0),
              reason: 'Stock set by bulk import',
              userId: a.userId ?? null,
              now,
            });
          out.updated++;
          if (r.existingSlug && r.existingSlug !== r.slug)
            out.renames.push({ from: r.existingSlug, to: r.slug });
        } else {
          productId = crypto.randomUUID();
          const sources = stampHumanEdits(aiCols, {}, {}, r.imported);
          db.run(
            `INSERT INTO products (id, store_id, ${cols.join(', ')}, ai_field_sources, created_at, updated_at)
             VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
            [productId, a.storeId, ...vals, JSON.stringify(sources), now, now]
          );
          importMovement(db, {
            storeId: a.storeId,
            productId,
            type: 'initial',
            previous: 0,
            next: Number(r.fields.inventory ?? 0),
            reason: 'Initial stock from bulk import',
            userId: a.userId ?? null,
            now,
          });
          out.created++;
        }
        if (r.categoryIds) {
          db.run('DELETE FROM product_categories WHERE product_id = ?', [productId]);
          for (const c of new Set(r.categoryIds))
            db.run(
              'INSERT OR IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?)',
              [productId, c]
            );
        }
        if (r.tagIds) {
          db.run('DELETE FROM product_tags WHERE product_id = ?', [productId]);
          for (const t of new Set(r.tagIds))
            db.run('INSERT OR IGNORE INTO product_tags (product_id, tag_id) VALUES (?, ?)', [
              productId,
              t,
            ]);
        }
        if (r.imageUrls) {
          db.run('DELETE FROM product_images WHERE product_id = ?', [productId]);
          r.imageUrls.forEach((url, position) =>
            db.run(
              'INSERT INTO product_images (id, product_id, url, position, created_at) VALUES (?, ?, ?, ?, ?)',
              [crypto.randomUUID(), productId, url, position, now]
            )
          );
        }
        if (r.variants && r.variants.length > 0)
          out.variantsCreated += replaceProductVariants(db, {
            storeId: a.storeId,
            productId,
            variants: r.variants,
            now,
            userId: a.userId ?? null,
          });
        out.products.push({ rowIndex: r.rowIndex, productId });
      } catch (e) {
        fail(r.rowIndex, e);
      }
    }
    return out;
  });
}

/** Variants for a parent product that already exists in the store but is not in the file (their own section, like Postgres). */
export function importVariantsForProduct(
  db: SyncSql,
  a: {
    storeId: string;
    productId: string;
    variants: ImportVariantRow[];
    now?: number;
    userId?: string | null;
  }
): { variantsCreated: number } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const p = db.all('SELECT id FROM products WHERE id = ? AND store_id = ?', [
      a.productId,
      a.storeId,
    ])[0];
    if (!p) throw new MoneyError('PRODUCT_NOT_FOUND', 'product not found', 404);
    try {
      return {
        variantsCreated: replaceProductVariants(db, {
          storeId: a.storeId,
          productId: a.productId,
          variants: a.variants,
          now,
          userId: a.userId ?? null,
        }),
      };
    } catch (e) {
      return fail(0, e);
    }
  });
}
