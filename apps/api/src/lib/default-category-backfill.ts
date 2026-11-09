/**
 * BE:F-5 / QA P2-5: stores provisioned before the Arabic default-category name shipped keep a default category
 * with `nameAr = null` inside their Durable Object (the Postgres migration cannot reach it). The merchant's
 * category list read repairs it lazily: only the untouched default row matches (slug 'products', name 'Products',
 * no Arabic name, not deleted), so a merchant-renamed row is never overwritten, and once repaired the read does
 * no write at all. Idempotent.
 */
export const DEFAULT_CATEGORY_NAME_AR = 'المنتجات';
export const DEFAULT_CATEGORY_DESCRIPTION_AR = 'كل المنتجات';

interface CategoryWriter {
  category: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

type Row = { slug?: string | null; name?: string | null; nameAr?: string | null };

export function needsDefaultCategoryBackfill(rows: Row[]): boolean {
  return rows.some(c => c.slug === 'products' && c.name === 'Products' && !c.nameAr);
}

/** Repairs the default row and patches the in-memory rows so this response already carries the Arabic name. */
export async function backfillDefaultCategoryNameAr<T extends Row>(
  w: CategoryWriter,
  storeId: string,
  rows: T[]
): Promise<boolean> {
  if (!needsDefaultCategoryBackfill(rows)) return false;
  await w.category.updateMany({
    where: { storeId, slug: 'products', name: 'Products', nameAr: null, deletedAt: null },
    data: { nameAr: DEFAULT_CATEGORY_NAME_AR, descriptionAr: DEFAULT_CATEGORY_DESCRIPTION_AR },
  });
  for (const c of rows) {
    if (c.slug === 'products' && c.name === 'Products' && !c.nameAr) {
      c.nameAr = DEFAULT_CATEGORY_NAME_AR;
      (c as Row & { descriptionAr?: string | null }).descriptionAr =
        DEFAULT_CATEGORY_DESCRIPTION_AR;
    }
  }
  return true;
}
