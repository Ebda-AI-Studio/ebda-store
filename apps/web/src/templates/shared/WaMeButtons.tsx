'use client';

/**
 * Free-tier WhatsApp (`wa.me` click-to-chat, SP8). Every button here is a plain
 * `<a href="https://wa.me/…">` — nothing is sent until the customer presses
 * send in WhatsApp, and there is NO API / network call from this file.
 *
 * A button renders only when the store has a valid Egyptian WhatsApp number
 * AND the matching merchant toggle is not off (`resolveWaMeVisibility`). All
 * five themes share the product page and the order pages, so these three
 * components are the single storefront implementation.
 */

import {
  buildCodConfirmationMessage,
  buildOrderQuestionMessage,
  buildProductShareMessage,
  productUrl,
  resolveWaMeVisibility,
  waMeLink,
  type WaMeAddress,
  type WaMeOrderItem,
} from '@ebda/shared';
import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { WhatsappGlyphIcon } from './icons';

function useWaMe() {
  const { store } = useStore();
  const { language, t } = useLanguage();
  return {
    store,
    locale: language,
    t,
    visibility: resolveWaMeVisibility(store.whatsapp, store.theme),
    storeName: language === 'ar' && store.nameAr ? store.nameAr : store.name,
  };
}

function WaLink({
  href,
  label,
  prominent,
  className = '',
  testId,
}: {
  href: string;
  label: string;
  prominent?: boolean;
  className?: string;
  testId: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className={
        (prominent
          ? 'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-5 py-3 text-base font-semibold text-white shadow-sm hover:brightness-95'
          : 'inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted') +
        ` ${className}`
      }
    >
      <WhatsappGlyphIcon
        className={`h-5 w-5 shrink-0 ${prominent ? '' : 'rounded-full bg-[#25D366] p-0.5'}`}
      />
      {label}
    </a>
  );
}

/** Product page: ask the merchant about / share this product on WhatsApp. */
export function WaMeProductButton({
  product,
  priceMinor,
  className = '',
}: {
  product: { slug: string; name: string; nameAr?: string | null };
  priceMinor?: number | null;
  className?: string;
}) {
  const { store, locale, t, visibility } = useWaMe();
  if (!visibility.productShare) return null;
  const text = buildProductShareMessage({
    locale,
    productName: locale === 'ar' && product.nameAr ? product.nameAr : product.name,
    priceMinor,
    url: productUrl(store, product.slug),
  });
  const href = waMeLink(store.whatsapp, text);
  if (!href) return null;
  return (
    <WaLink
      href={href}
      testId="wa-me-product"
      className={className}
      label={t('Ask or share on WhatsApp', 'اسأل أو شارك على واتساب')}
    />
  );
}

/** Thank-you page: prominent "Confirm on WhatsApp" for cash-on-delivery orders. */
export function WaMeCodConfirmButton({
  order,
  className = '',
}: {
  order: {
    orderNumber: string;
    total: number;
    items: Array<{ quantity: number; product?: { name: string; nameAr?: string | null } | null }>;
    shippingAddress?: WaMeAddress | null;
  };
  className?: string;
}) {
  const { store, locale, t, visibility, storeName } = useWaMe();
  if (!visibility.codConfirm) return null;
  const items: WaMeOrderItem[] = order.items
    .filter(i => i.product?.name)
    .map(i => ({
      name: i.product!.name,
      nameAr: i.product!.nameAr,
      quantity: i.quantity,
    }));
  const href = waMeLink(
    store.whatsapp,
    buildCodConfirmationMessage({
      locale,
      orderNumber: order.orderNumber,
      items,
      totalMinor: order.total,
      address: order.shippingAddress,
      storeName,
    })
  );
  if (!href) return null;
  return (
    <div className={className}>
      <WaLink
        href={href}
        prominent
        testId="wa-me-cod-confirm"
        label={t('Confirm on WhatsApp', 'أكّد على واتساب')}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'Send us the prefilled message so we can confirm your order faster.',
          'ابعت لنا الرسالة الجاهزة عشان نأكد طلبك أسرع.'
        )}
      </p>
    </div>
  );
}

/** Order page: ask the merchant about this order. */
export function WaMeOrderQuestionButton({
  orderNumber,
  className = '',
}: {
  orderNumber: string;
  className?: string;
}) {
  const { store, locale, t, visibility, storeName } = useWaMe();
  if (!visibility.orderQuestion) return null;
  const href = waMeLink(
    store.whatsapp,
    buildOrderQuestionMessage({ locale, orderNumber, storeName })
  );
  if (!href) return null;
  return (
    <WaLink
      href={href}
      testId="wa-me-order-question"
      className={className}
      label={t('Ask about this order', 'اسأل عن هذا الطلب')}
    />
  );
}
