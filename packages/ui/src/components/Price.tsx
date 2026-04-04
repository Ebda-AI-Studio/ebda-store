'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';
import { formatPrice } from '@force/shared';

export interface PriceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Price in fils (1 KWD = 1000 fils) */
  price: number;
  /** Original price for showing discount (in fils) */
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
