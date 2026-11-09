import { describe, it, expect, vi } from 'vitest';
import { backfillDefaultCategoryNameAr } from '../default-category-backfill';

const writer = () => ({ category: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } });

describe('BE:F-5 / QA P2-5 default category nameAr backfill', () => {
  it('repairs the untouched default row and patches the response', async () => {
    const w = writer();
    const rows = [{ slug: 'products', name: 'Products', nameAr: null as string | null }];
    expect(await backfillDefaultCategoryNameAr(w, 's1', rows)).toBe(true);
    expect(w.category.updateMany).toHaveBeenCalledWith({
      where: { storeId: 's1', slug: 'products', name: 'Products', nameAr: null, deletedAt: null },
      data: { nameAr: 'المنتجات', descriptionAr: 'كل المنتجات' },
    });
    expect(rows[0].nameAr).toBe('المنتجات');
  });

  it('writes nothing when the default row already has an Arabic name (idempotent)', async () => {
    const w = writer();
    const rows = [{ slug: 'products', name: 'Products', nameAr: 'المنتجات' }];
    expect(await backfillDefaultCategoryNameAr(w, 's1', rows)).toBe(false);
    expect(w.category.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a merchant-renamed row alone', async () => {
    const w = writer();
    const rows = [{ slug: 'products', name: 'Bags', nameAr: null }];
    expect(await backfillDefaultCategoryNameAr(w, 's1', rows)).toBe(false);
    expect(w.category.updateMany).not.toHaveBeenCalled();
  });
});
