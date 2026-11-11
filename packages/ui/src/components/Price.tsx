'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';
import { formatPrice, localizeDigits, REGION, type Numerals, formatSigned } from '@ebda/shared';

export interface PriceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Price in piastres (1 EGP = 100 piastres). For products with variants
   *  this is the cheapest variant's price (the caller resolves which
   *  number to pass via product-pricing.ts). */
  price: number;
  /** Original price for showing discount (in piastres). Pass `null` for
   *  variant-parent cards where the parent's compareAtPrice is stale
   *  pre-fold data; the helper already filters those out. */
  compareAtPrice?: number;
  /** Currency code (default: EGP) */
  currency?: string;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Digit system (Ruling NUMERALS-1). Default Western `'latn'`; pass the
   *  store's opt-in (`'arab'`) and it applies only to the Arabic locale. */
  numerals?: Numerals;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Show discount percentage badge */
  showDiscount?: boolean;
  /** Custom discount label */
  discountLabel?: string;
  /** Prefix the price with "From" / "ابتداءً من". Use on listing cards
   *  for multi-variant products where the headline is the cheapest
   *  variant — without the prefix the customer thinks it's a fixed
   *  price and feels misled when they pick a bigger size. */
  fromPrefix?: boolean;
}

const sizeStyles = {
  sm: 'text-sm font-semibold',
  md: 'text-lg font-bold',
  lg: 'text-xl font-bold',
  xl: 'text-3xl font-bold',
};

const compareSizeStyles = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-sm',
  xl: 'text-base',
};

/**
 * Price component with currency formatting, discount display, and RTL support.
 * Handles piastres to currency conversion automatically.
 */
export const Price = forwardRef<HTMLDivElement, PriceProps>(
  (
    {
      price,
      compareAtPrice,
      currency = REGION.currency,
      isRtl = false,
      numerals = 'latn',
      size = 'md',
      showDiscount = true,
      discountLabel,
      fromPrefix = false,
      className,
      ...props
    },
    ref
  ) => {
    // A price never splits from its currency at a line end: the one space is a no-break space
    // (same rule as the storefront's useLocalePrice, STOP-2 re-audit).
    const fmtPrice = (amount: number) =>
      formatPrice(amount, {
        currency,
        locale: isRtl ? 'ar' : 'en',
        numerals,
      }).replace(' ', '\u00A0');

    const discount =
      compareAtPrice && compareAtPrice > price
        ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
        : 0;

    const hasDiscount = discount > 0;

    return (
      <div
        ref={ref}
        // data-zone="productPrice" so the per-store typography
        // sub-zone (configured in the admin) overrides Price font /
        // size / color across every template that uses this shared
        // component.
        data-zone="productPrice"
        className={cn('flex items-center gap-2 flex-wrap', className)}
        dir={isRtl ? 'rtl' : 'ltr'}
        {...props}
      >
        {fromPrefix && (
          <span className="text-xs text-muted-foreground">{isRtl ? 'ابتداءً من' : 'From'}</span>
        )}
        {/* Current Price */}
        <span className={cn('font-bold text-primary', sizeStyles[size])}>{fmtPrice(price)}</span>

        {/* Compare At Price */}
        {hasDiscount && (
          <span className={cn('text-muted-foreground line-through', compareSizeStyles[size])}>
            {fmtPrice(compareAtPrice!)}
          </span>
        )}

        {/* Discount Badge */}
        {hasDiscount && showDiscount && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-destructive text-destructive-foreground">
            {discountLabel ||
              (isRtl
                ? `${localizeDigits(discount, numerals)}% خصم`
                : formatSigned(-discount, { format: abs => `${abs}%` }))}
          </span>
        )}
      </div>
    );
  }
);

Price.displayName = 'Price';

// Re-export the shared formatPrice for consumers that imported it from @ebda/ui
export { formatPrice } from '@ebda/shared';
