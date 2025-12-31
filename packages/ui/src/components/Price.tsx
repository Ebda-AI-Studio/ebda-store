'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';

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
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
  xl: 'text-2xl',
};

const compareSizeStyles = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
  xl: 'text-lg',
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
    const formatPrice = (amount: number) => {
      const decimals = currency === 'KWD' ? 3 : 2;
      const divisor = currency === 'KWD' ? 1000 : 100;

      return new Intl.NumberFormat(isRtl ? 'ar-KW' : 'en-KW', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(amount / divisor);
    };

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
        <span
          className={cn(
            'font-bold text-primary',
            sizeStyles[size]
          )}
        >
          {formatPrice(price)}
        </span>

        {/* Compare At Price */}
        {hasDiscount && (
          <span
            className={cn(
              'text-muted-foreground line-through',
              compareSizeStyles[size]
            )}
          >
            {formatPrice(compareAtPrice!)}
          </span>
        )}

        {/* Discount Badge */}
        {hasDiscount && showDiscount && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            {discountLabel || (isRtl ? `${discount}% خصم` : `-${discount}%`)}
          </span>
        )}
      </div>
    );
  }
);

Price.displayName = 'Price';

/**
 * Utility function to format price outside of component
 */
export function formatPrice(
  amount: number,
  options: {
    currency?: string;
    isRtl?: boolean;
  } = {}
): string {
  const { currency = 'KWD', isRtl = false } = options;
  const decimals = currency === 'KWD' ? 3 : 2;
  const divisor = currency === 'KWD' ? 1000 : 100;

  return new Intl.NumberFormat(isRtl ? 'ar-KW' : 'en-KW', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount / divisor);
}
