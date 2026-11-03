'use client';

import Image from 'next/image';
import { useLocalePrice } from '../hooks/useLocalePrice';
import { useLanguage } from '../contexts/LanguageContext';
import { useNumerals } from '../hooks/useNumerals';
import { MissingImage } from '../templates/shared/MissingImage';

/** Exported for reuse by `bundles/BundleCard.tsx` (the `/bundles` index
 *  grid) — same "no image yet" glyph everywhere a bundle can render
 *  imageless, rather than a second hand-drawn icon. */
export function BundlePlaceholderIcon() {
  return <MissingImage size="sm" />;
}

function TrashIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

export interface BundleLineProps {
  name: string;
  nameAr?: string | null;
  image?: string | null;
  /**
   * Number of boxes this row represents. On the cart, this is the
   * `CartBundle` row's quantity (a customer can add 2 of the same box in
   * one add-to-cart, which can be >1). A caller rendering a POST-checkout
   * row (this component isn't used for that today — see the file docstring
   * — but a future caller might be) should always pass `1`: a
   * `bundleGroupId` is exactly one box (Task 6 writes one group per box
   * specifically so a single box is independently returnable), and buying
   * 2 boxes is two separate rows, never one row with quantity 2.
   */
  quantity: number;
  /**
   * Total price for this row, already multiplied by `quantity`. This must
   * be the bundle's price — NEVER the sum of the per-component allocated
   * shares. Those shares exist only for admin/picking/accounting and must
   * never reach this component.
   */
  total: number;
  /**
   * The component products' combined normal price, when higher than
   * `total` — renders a "Save X" badge. Omit when unknown; no badge is
   * shown, never a wrong one.
   */
  componentSum?: number;
  /**
   * `card` matches the cart page's own item rows (bigger image,
   * standalone bordered card). `row` matches the compact divide-y rows
   * used in the checkout order summary. Defaults to `row`.
   */
  variant?: 'card' | 'row';
  /**
   * Units of this bundle's LIMITING component still purchasable — `CartBundle.available`
   * / `CheckoutCartBundle.available`, both sourced from the same `CartBundleView.available`
   * the API computes. Omit when unknown (older callers / not yet threaded through); no
   * indicator renders, matching the behaviour before this prop existed. When present and
   * lower than `quantity`, an inline "out of stock" note renders — the bundle equivalent
   * of the product-card OOS ribbon, sized for this compact row rather than reusing the
   * full merchant-configurable ribbon system (that one is styled for a product image, not
   * a 64px cart/checkout thumbnail).
   */
  available?: number;
  /** Cart-only — omit on read-only surfaces (checkout summary). */
  onRemove?: () => void;
  isRtl?: boolean;
  /** data-testid override — defaults to 'cart-line' so a bundle row counts
   *  toward the same "one row per line" assertion as a product line. */
  testId?: string;
}

/**
 * Renders ONE bundle box as a single row: image, name, quantity, price,
 * and an optional "Save X" badge. Used on `CartClient.tsx` (`variant="card"`)
 * and the checkout `OrderSummary.tsx` (`variant="row"`) — both list a small,
 * homogeneous set of lines where a shared row component is the natural fit.
 *
 * It is deliberately NOT used on the order-confirmation receipt
 * (`components/commerce/ReceiptPrinter.tsx`) or order-detail
 * (`account/orders/[id]/OrderDetailClient.tsx`) views. Those hand-roll their
 * own equivalent bundle-row markup instead, because their SHAPE differs from
 * a simple row list: order-detail renders a `<table>` (desktop) and a
 * separate mobile list, each with different columns/classes per row-kind,
 * and the confirmation receipt's rows are thermal-paper text lines with
 * no image at all. All four surfaces still collapse a box to ONE row via
 * the same `groupOrderLinesForDisplay` function and never show a
 * per-component allocated price — that invariant lives in the shared
 * grouping function, not in this component being reused everywhere.
 */
export function BundleLine({
  name,
  nameAr,
  image,
  quantity,
  total,
  componentSum,
  variant = 'row',
  onRemove,
  isRtl: isRtlProp,
  testId = 'cart-line',
  available,
}: BundleLineProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayName = isRtl && nameAr ? nameAr : name;
  const savings = componentSum && componentSum > total ? componentSum - total : 0;
  // Same semantics as the server's gate (#2053): the order's atomic stock
  // decrement (order.service.ts, Ruling T5-c) refuses when a component has
  // less stock than THIS quantity of boxes needs — not only when the box is
  // sold out. So the note fires on `available < quantity`, but it must say
  // which case it is: "Out of stock" next to a box with 2 of 5 left is false.
  const stockNote =
    available === undefined || available >= quantity
      ? null
      : available <= 0
        ? t('Out of stock', 'غير متوفر')
        : t(`Only ${localize(available)} available`, `المتوفر ${localize(available)} بس`);

  const badge = (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      {t('Bundle', 'باقة')}
    </span>
  );

  const outOfStockNote = stockNote ? (
    <p data-bundle-stock-note="" className="mt-1 text-xs font-semibold text-destructive-ink">
      {stockNote}
    </p>
  ) : null;

  if (variant === 'card') {
    return (
      <div
        data-testid={testId}
        data-bundle-line="true"
        dir={isRtl ? 'rtl' : 'ltr'}
        className="flex gap-4 rounded-[var(--radius)] border border-border/60 bg-card p-4 sm:p-5"
      >
        <div className="h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg bg-muted sm:h-28 sm:w-28">
          {image ? (
            <Image
              src={image}
              alt={displayName}
              width={112}
              height={112}
              className="h-full w-full object-cover"
              sizes="(max-width: 640px) 96px, 112px"
            />
          ) : (
            <BundlePlaceholderIcon />
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2 sm:gap-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              {badge}
              <h3 className="mt-0.5 text-lg font-bold text-foreground sm:text-xl">{displayName}</h3>
              {outOfStockNote}
            </div>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label={t('Remove bundle', 'إزالة الباقة')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-ink"
              >
                <TrashIcon />
              </button>
            )}
          </div>
          <div className="mt-auto flex items-center justify-between pt-2">
            <span className="text-sm font-semibold text-foreground">
              {t('Qty', 'الكمية')}: {localize(quantity)}
            </span>
            <div className="text-right">
              {savings > 0 && (
                <p className="text-xs font-medium text-success-ink">
                  {t('Save', 'وفّر')} {formatPrice(savings)}
                </p>
              )}
              <p className="text-base font-bold text-primary sm:text-lg">{formatPrice(total)}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 'row' — compact, matches the checkout OrderSummary's item rows (image +
  // qty badge, name, price). See the file docstring for why order
  // confirmation / order detail hand-roll their own row markup instead of
  // using this variant.
  return (
    <div
      data-testid={testId}
      data-bundle-line="true"
      dir={isRtl ? 'rtl' : 'ltr'}
      className="flex gap-4 py-4 first:pt-0"
    >
      {/* IA-07: the badge sits outside the clipped thumbnail, logical, on the ink pair. */}
      <div className="relative h-16 w-16 flex-shrink-0">
        <div className="relative h-full w-full overflow-hidden rounded-[var(--radius)] bg-muted">
          {image ? (
            <Image src={image} alt={displayName} fill className="object-cover" />
          ) : (
            <BundlePlaceholderIcon />
          )}
        </div>
        <span
          data-testid="line-qty-badge"
          className="absolute -end-1 -top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-xs text-background"
        >
          {localize(quantity)}
        </span>
      </div>
      <div className="flex flex-1 flex-col">
        {badge}
        <h3 className="mt-0.5 text-base font-semibold text-foreground">{displayName}</h3>
        {outOfStockNote}
        {savings > 0 && (
          <p className="text-xs font-medium text-success-ink">
            {t('Save', 'وفّر')} {formatPrice(savings)}
          </p>
        )}
        <p className="mt-auto text-sm font-medium text-muted-foreground">{formatPrice(total)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('Remove bundle', 'إزالة الباقة')}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center self-start rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-ink"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}
