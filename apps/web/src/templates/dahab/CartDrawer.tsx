'use client';

/**
 * The Dahab bag: a drawer over the page with the cart lines, a quantity
 * stepper, the subtotal and the way on to checkout. Reads and writes the
 * one CartContext (the same cart the /cart page shows), so the two can
 * never disagree; prices are the server's numbers, formatted only.
 */
import { VariantText } from '@ebda/ui';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import { useCart } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useNumerals } from '../../hooks/useNumerals';
import { DahabDrawer } from './Drawer';
import { CartLineNote } from '../../components/commerce/CartLineNote';
import { DAHAB_BTN_PRIMARY, DAHAB_BTN_SECONDARY, MinusIcon, PlusIcon, cx } from './ui';
import { CART_CHECKOUT_CTA } from '../../lib/checkout-cta';

export function DahabCartDrawer({
  open,
  onClose,
  urlPrefix,
}: {
  open: boolean;
  onClose: () => void;
  urlPrefix: string;
}) {
  const { items, bundles, total, itemCount, updateQuantity, removeItem } = useCart();
  const { isRtl, t } = useLanguage();
  const formatPrice = useLocalePrice();
  const { localize } = useNumerals();
  const empty = items.length === 0 && bundles.length === 0;
  const blocked = items.some(i => i.unavailable);

  return (
    <DahabDrawer
      open={open}
      onClose={onClose}
      side="end"
      label={
        itemCount > 0 ? `${t('Your bag', 'سلتك')} (${localize(itemCount)})` : t('Your bag', 'سلتك')
      }
      closeLabel={t('Close bag', 'إغلاق السلة')}
      footer={
        empty ? undefined : (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">
                {t('Subtotal', 'المجموع الفرعي')}
              </span>
              <span className="text-lg tabular-nums text-foreground">{formatPrice(total)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                'Delivery and payment options (cash on delivery, InstaPay, cards) at checkout.',
                'التوصيل وطرق الدفع (عند الاستلام، إنستاباي، الكروت) في الخطوة الجاية.'
              )}
            </p>
            {blocked && (
              <p className="text-xs text-destructive-ink">
                {t(
                  'Remove the items that are no longer available to check out.',
                  'احذف القطع اللي مبقتش متاحة عشان تكمل الطلب.'
                )}
              </p>
            )}
            <div className="grid gap-2">
              {blocked ? (
                <span
                  aria-disabled="true"
                  className={cx(DAHAB_BTN_PRIMARY, 'pointer-events-none opacity-50')}
                >
                  {t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}
                </span>
              ) : (
                <Link
                  href={`${urlPrefix}/checkout`}
                  className={DAHAB_BTN_PRIMARY}
                  onClick={onClose}
                >
                  {t(CART_CHECKOUT_CTA.en, CART_CHECKOUT_CTA.ar)}
                </Link>
              )}
              <Link href={`${urlPrefix}/cart`} className={DAHAB_BTN_SECONDARY} onClick={onClose}>
                {t('View bag', 'عرض السلة')}
              </Link>
            </div>
          </div>
        )
      }
    >
      {empty ? (
        <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
          <p className="font-display text-2xl text-foreground">
            {t('Your bag is empty', 'سلتك فاضية')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(
              'Rings, chains, bracelets and earrings are waiting.',
              'الخواتم والسلاسل والأساور والحلقان مستنياك.'
            )}
          </p>
          <Link href={`${urlPrefix}/products`} className={DAHAB_BTN_SECONDARY} onClick={onClose}>
            {t('Shop the collection', 'تصفح المجموعة')}
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border px-5">
          {items.map(item => {
            const name = (isRtl && item.nameAr ? item.nameAr : item.name) || '';
            const variant =
              (isRtl && item.variantTitleAr ? item.variantTitleAr : item.variantTitle) ||
              item.variantTitleAr;
            return (
              <li key={item.id} className={cx('flex gap-4 py-5', item.unavailable && 'opacity-60')}>
                <Link
                  href={`${urlPrefix}/products/${item.slug}`}
                  onClick={onClose}
                  aria-label={name}
                  className="relative aspect-[4/5] w-20 shrink-0 overflow-hidden rounded-[var(--radius)] bg-card"
                >
                  {item.image && (
                    <Image src={item.image} alt="" fill sizes="80px" className="object-cover" />
                  )}
                </Link>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-sm leading-snug text-foreground">{name}</p>
                    <p className="shrink-0 text-sm tabular-nums text-primary">
                      {formatPrice(item.price * item.quantity)}
                    </p>
                  </div>
                  {variant && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <VariantText title={variant} />
                    </p>
                  )}
                  <CartLineNote note={item.note} />
                  {item.unavailable && (
                    <p className="mt-1 text-xs text-destructive-ink">
                      {t('No longer available', 'مبقتش متاحة')}
                    </p>
                  )}
                  <div className="mt-auto flex items-center justify-between pt-3">
                    {!item.unavailable ? (
                      <div className="flex items-center rounded-[var(--radius)] border border-input">
                        <button
                          type="button"
                          onClick={() =>
                            item.quantity > 1
                              ? updateQuantity(item.id, item.quantity - 1)
                              : removeItem(item.id)
                          }
                          aria-label={t('Decrease quantity', 'تقليل الكمية')}
                          className="flex h-11 w-11 items-center justify-center text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <MinusIcon className="h-3.5 w-3.5" />
                        </button>
                        <span aria-live="polite" className="w-8 text-center text-sm tabular-nums">
                          {localize(item.quantity)}
                        </span>
                        <button
                          type="button"
                          onClick={() => updateQuantity(item.id, item.quantity + 1)}
                          aria-label={t('Increase quantity', 'زيادة الكمية')}
                          className="flex h-11 w-11 items-center justify-center text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <PlusIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      onClick={() => removeItem(item.id)}
                      className="min-h-[44px] text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {t('Remove', 'حذف')}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
          {bundles.length > 0 && (
            <li className="py-5 text-sm text-muted-foreground">
              <Link
                href={`${urlPrefix}/cart`}
                onClick={onClose}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {t(
                  `${bundles.length} bundle(s) — view in your bag`,
                  `${localize(bundles.length)} باقة — اعرضها في السلة`
                )}
              </Link>
            </li>
          )}
        </ul>
      )}
    </DahabDrawer>
  );
}
