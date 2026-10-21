/**
 * IA-06 (independent audit P1): removing a line had no undo, and the Arabic toast named the product
 * in English ("شيلنا Silk shawl ...") because the remove path read `name`, not the localized one.
 */
import { describe, it, expect, vi } from 'vitest';
import { cartRemovalToast } from './cart-removal';

const t = (_en: string, ar: string) => ar;
const item = {
  id: 'line-1',
  productId: 'p1',
  name: 'Silk shawl',
  nameAr: 'شال حرير',
  price: 32000,
  quantity: 2,
  slug: 'silk-shawl',
  variantId: 'v9',
  note: 'منى',
};

describe('cartRemovalToast', () => {
  it('names the product in the page language', () => {
    const toast = cartRemovalToast(item, { isRtl: true, t, addItem: vi.fn() });
    expect(toast.message).toBe('شيلنا شال حرير من السلة');
    expect(toast.message).not.toContain('Silk');
  });
  it('English page: the English name', () => {
    const en = (e: string) => e;
    expect(cartRemovalToast(item, { isRtl: false, t: en, addItem: vi.fn() }).message).toBe(
      'Silk shawl removed from your cart'
    );
  });
  it('undo puts the same line back (product, variant, note, quantity)', async () => {
    const addItem = vi.fn().mockResolvedValue(true);
    const toast = cartRemovalToast(item, { isRtl: true, t, addItem });
    expect(toast.action.label).toBe('تراجع');
    toast.action.onClick();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'p1',
        variantId: 'v9',
        note: 'منى',
        name: 'Silk shawl',
        nameAr: 'شال حرير',
      }),
      2
    );
  });
});
