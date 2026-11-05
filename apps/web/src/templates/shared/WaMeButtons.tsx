'use client';

/**
 * Free-tier WhatsApp (`wa.me` click-to-chat, SP8). Every button here is a plain
 * `<a href="https://wa.me/…">` — nothing is sent until the customer presses
 * send in WhatsApp, and there is NO API / network call from this file.
 *
 * A button renders only when the store has a valid Egyptian WhatsApp number
 * AND the matching merchant toggle is not off (`resolveWaMeVisibility`). All
 * every template shares the product page and the order pages, so these three
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
  disabled,
  onBlocked,
}: {
  href: string;
  label: string;
  prominent?: boolean;
  className?: string;
  testId: string;
  /** Rendered but not followable (no href), e.g. a required personalisation is empty. */
  disabled?: boolean;
  /**
   * With `disabled`: the blocked tap does something (the PDP nudges the empty field) instead of
   * being inert, so it renders a real button, still `aria-disabled`, and stays tappable.
   */
  onBlocked?: () => void;
}) {
  const classes = (extra: string) =>
    extra +
    (prominent
      ? 'inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-5 py-3 text-base font-semibold text-white shadow-sm hover:brightness-95'
      : 'inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted') +
    ` ${className}`;
  const glyph = (
    <WhatsappGlyphIcon
      className={`h-5 w-5 shrink-0 ${prominent ? '' : 'rounded-full bg-[#25D366] p-0.5'}`}
    />
  );
  if (disabled && onBlocked) {
    return (
      <button
        type="button"
        data-testid={testId}
        aria-disabled="true"
        onClick={onBlocked}
        className={classes('opacity-50 ')}
      >
        {glyph}
        {label}
      </button>
    );
  }
  return (
    <a
      href={disabled ? undefined : href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      aria-disabled={disabled || undefined}
      className={classes(disabled ? 'pointer-events-none opacity-50 ' : '')}
    >
      {glyph}
      {label}
    </a>
  );
}

/**
 * True when `WaMeProductButton` renders for this store (number valid, toggle on). The PDP's
 * share row reads it to drop its own WhatsApp pill, so one page never carries two WhatsApp
 * rows doing the same job (audit 2026-11-03 #13).
 */
export function useHasWaMeProductButton(product: { slug: string; name: string }): boolean {
  const { store, locale, visibility } = useWaMe();
  if (!visibility.productShare) return false;
  const href = waMeLink(
    store.whatsapp,
    buildProductShareMessage({
      locale,
      productName: product.name,
      priceMinor: null,
      url: productUrl(store, product.slug),
    })
  );
  return Boolean(href);
}

/** Product page: ask the merchant about / share this product on WhatsApp. */
export function WaMeProductButton({
  product,
  priceMinor,
  className = '',
  personalisation,
  disabled,
  onBlocked,
}: {
  product: { slug: string; name: string; nameAr?: string | null };
  priceMinor?: number | null;
  className?: string;
  /** The customer's typed text, carried into the WhatsApp message. */
  personalisation?: { label: string; note: string } | null;
  /** Same gate as add-to-cart's required-personalisation rule. */
  disabled?: boolean;
  /** Tap while `disabled`: the PDP's `noteMissing` nudge (scroll to + focus the field). */
  onBlocked?: () => void;
}) {
  const { store, locale, t, visibility } = useWaMe();
  if (!visibility.productShare) return null;
  const text = buildProductShareMessage({
    locale,
    productName: locale === 'ar' && product.nameAr ? product.nameAr : product.name,
    priceMinor,
    url: productUrl(store, product.slug),
    personalisation,
  });
  const href = waMeLink(store.whatsapp, text);
  if (!href) return null;
  return (
    <WaLink
      href={href}
      testId="wa-me-product"
      className={className}
      disabled={disabled}
      onBlocked={onBlocked}
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
    deliveryLine?: string | null;
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
      deliveryLine: order.deliveryLine,
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
          'ابعتلنا الرسالة الجاهزة عشان نأكد طلبك أسرع.'
        )}
      </p>
    </div>
  );
}

/**
 * The "ask about this order" wa.me link, or null when the store has no valid
 * number, the merchant turned the order-question toggle off, or there is no
 * order yet. Shared by the order page button and the receipt (S-02).
 */
export function useOrderQuestionHref(orderNumber: string | null | undefined): string | null {
  const { store, locale, visibility, storeName } = useWaMe();
  if (!orderNumber || !visibility.orderQuestion) return null;
  return waMeLink(store.whatsapp, buildOrderQuestionMessage({ locale, orderNumber, storeName }));
}

/** Order page: ask the merchant about this order. */
export function WaMeOrderQuestionButton({
  orderNumber,
  className = '',
}: {
  orderNumber: string;
  className?: string;
}) {
  const { t } = useWaMe();
  const href = useOrderQuestionHref(orderNumber);
  if (!href) return null;
  return (
    <WaLink
      href={href}
      testId="wa-me-order-question"
      className={className}
      label={t('Ask about this order', 'اسأل عن الطلب ده')}
    />
  );
}
