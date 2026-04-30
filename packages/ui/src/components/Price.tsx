'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';
import { formatPrice } from '@force/shared';

export interface PriceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Price in fils (1 KWD = 1000 fils). For products with variants
   *  this is the cheapest variant's price (the caller resolves which
   *  number to pass via product-pricing.ts). */
  price: number;
  /** Original price for showing discount (in fils). Pass `null` for
   *  variant-parent cards where the parent's compareAtPrice is stale
   *  pre-fold data; the helper already filters those out. */
  compareAtPrice?: number;
  /** Currency code (default: KWD) */
  currency?: string;
  /** Show in RTL format */
  isRtl?: boolean;
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
 * Handles fils to currency conversion automatically.
 */
export const Price = forwardRef<HTMLDivElement, PriceProps>(
  (
    {
      price,
      compareAtPrice,
      currency = 'KWD',
      isRtl = false,
      size = 'md',
      showDiscount = true,
      discountLabel,
      fromPrefix = false,
      className,
      ...props
    },
    ref
  ) => {
    const fmtPrice = (amount: number) =>
      formatPrice(amount, {
        currency,
        locale: isRtl ? 'ar-KW' : 'en-KW',
      });

    const discount =
      compareAtPrice && compareAtPrice > price
        ? Math.round(((compareAtPrice - price) / compareAtPrice) * 100)
        : 0;

    const hasDiscount = discount > 0;

    return (
      <div
        ref={ref}
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
          <span className={cn('text-muted-foreground/60 line-through', compareSizeStyles[size])}>
            {fmtPrice(compareAtPrice!)}
          </span>
        )}

        {/* Discount Badge */}
        {hasDiscount && showDiscount && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-destructive text-destructive-foreground">
            {discountLabel || (isRtl ? `${discount}% خصم` : `-${discount}%`)}
          </span>
        )}
      </div>
    );
  }
);

Price.displayName = 'Price';

// Re-export the shared formatPrice for consumers that imported it from @force/ui
export { formatPrice } from '@force/shared';
