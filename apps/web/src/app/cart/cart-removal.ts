import type { CartItem } from '../../contexts/CartContext';
import { pickLocalizedName } from '../../templates/shared/display-helpers';

/**
 * IA-06 (W4): the toast after removing a cart line. It names the product in the page language
 * (the add path already did; the remove path read `name`) and offers "Undo", which puts the same
 * line back: product, variant, personalisation note and quantity.
 */
export function cartRemovalToast(
  item: Pick<
    CartItem,
    | 'productId'
    | 'name'
    | 'nameAr'
    | 'price'
    | 'quantity'
    | 'slug'
    | 'image'
    | 'variantId'
    | 'note'
    | 'category'
  >,
  ctx: {
    isRtl: boolean;
    t: (en: string, ar: string) => string;
    addItem: (
      line: Omit<CartItem, 'quantity' | 'productId'>,
      quantity?: number
    ) => Promise<boolean>;
  }
) {
  const name = pickLocalizedName(item, ctx.isRtl) ?? item.name;
  return {
    type: 'success' as const,
    title: ctx.t('Item removed', 'تمت الإزالة'),
    message: ctx.t(`${name} removed from your cart`, `تمت إزالة ${name} من السلة`),
    duration: 6000,
    action: {
      label: ctx.t('Undo', 'تراجع'),
      onClick: () => {
        void ctx.addItem(
          {
            id: item.productId,
            name: item.name,
            nameAr: item.nameAr,
            price: item.price,
            slug: item.slug,
            image: item.image,
            category: item.category,
            variantId: item.variantId,
            note: item.note,
          },
          item.quantity
        );
      },
    },
  };
}
