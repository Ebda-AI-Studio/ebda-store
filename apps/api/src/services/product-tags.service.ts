import { storeDb, storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { invalidateStoreProductCaches } from '../lib/public-cache';

/**
 * Which tags sit on which products (the Tag / ProductTag rows the storefront filter chips read). There is no per-product tag
 * endpoint in the dashboard: merchants set tags through the CSV import (bulk.service.ts, "tags" column, names, replace) and the AI
 * tag sweep (additive). This is the same write for the Store assistant: tag names are matched to the store's existing tags
 * case-insensitively, missing ones are created, links are added/removed per product. Every id is store-scoped (404 otherwise).
 */
export type TagMode = 'add' | 'remove' | 'set';
export interface ProductTagChange {
  productId: string;
  tags: string[];
}

const clean = (names: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
};

/** Current name + tag names per product (name order). Throws 404 when any product is not in this store. */
export async function getProductTags(
  storeId: string,
  productIds: string[]
): Promise<Record<string, { name: string; tags: string[] }>> {
  const ids = [...new Set(productIds)];
  const rows = await (
    await storeDb(storeId)
  ).product.findMany({
    where: { storeId, id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, tags: { select: { tag: { select: { name: true } } } } },
  });
  if (rows.length !== ids.length) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return Object.fromEntries(
    rows.map(r => [
      r.id,
      { name: r.name, tags: r.tags.map(t => t.tag.name).sort((a, b) => a.localeCompare(b)) },
    ])
  );
}

export async function applyProductTags(
  storeId: string,
  changes: ProductTagChange[],
  mode: TagMode
): Promise<void> {
  const ids = [...new Set(changes.map(c => c.productId))];
  const current = await getProductTags(storeId, ids); // 404 on a foreign product, before any write
  const w = await storeWriter(storeId);

  const wanted = clean(changes.flatMap(c => c.tags));
  const loadTags = async () =>
    new Map(
      (await w.tag.findMany({ where: { storeId }, select: { id: true, name: true } })).map(
        t => [t.name.toLowerCase(), t.id] as const
      )
    );
  let byName = await loadTags();
  if (mode !== 'remove') {
    const missing = wanted.filter(n => !byName.has(n.toLowerCase()));
    if (missing.length > 0) {
      await w.tag.createMany({
        data: missing.map(name => ({ storeId, name })),
        skipDuplicates: true,
      });
      byName = await loadTags();
    }
  }

  for (const c of changes) {
    const names = clean(c.tags);
    const have = new Set((current[c.productId]?.tags ?? []).map(n => n.toLowerCase()));
    const want = new Set(names.map(n => n.toLowerCase()));
    const idOf = (lower: string) => byName.get(lower);
    const toAdd = mode === 'remove' ? [] : [...want].filter(n => !have.has(n));
    const toRemove =
      mode === 'add'
        ? []
        : mode === 'remove'
          ? [...want].filter(n => have.has(n))
          : [...have].filter(n => !want.has(n));
    const removeIds = toRemove.map(idOf).filter((x): x is string => !!x);
    const addIds = toAdd.map(idOf).filter((x): x is string => !!x);
    if (removeIds.length > 0) {
      await w.productTag.deleteMany({
        where: { productId: c.productId, tagId: { in: removeIds } },
      });
    }
    if (addIds.length > 0) {
      await w.productTag.createMany({
        data: addIds.map(tagId => ({ productId: c.productId, tagId })),
        skipDuplicates: true,
      });
    }
  }
  await invalidateStoreProductCaches(storeId);
}
