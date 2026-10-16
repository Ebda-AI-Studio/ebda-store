'use client';

import { forwardRef, useState } from 'react';
import { cn } from '../utils/cn';
import { Button, type ButtonProps } from './Button';
import { CartIcon } from './CartIcon';

export interface AddToCartButtonProps extends Omit<ButtonProps, 'onClick' | 'variant'> {
  /** Product ID for cart operations */
  productId: string;
  /** Whether product is in stock */
  inStock?: boolean;
  /** Current quantity in cart */
  quantityInCart?: number;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Callback when add to cart is clicked */
  onAddToCart?: (productId: string) => Promise<void> | void;
  /** Custom labels */
  labels?: {
    addToCart?: string;
    addedToCart?: string;
    outOfStock?: string;
    adding?: string;
  };
  /** Show quantity badge when in cart */
  showQuantityBadge?: boolean;
  /** Button variant style */
  variant?: 'default' | 'outline' | 'ghost';
  /** Icon only mode */
  iconOnly?: boolean;
}

const defaultLabels = {
  en: {
    addToCart: 'Add to Cart',
    addedToCart: 'Added!',
    outOfStock: 'Out of Stock',
    adding: 'Adding...',
  },
  ar: {
    addToCart: 'أضف للسلة',
    addedToCart: 'اتضاف!',
    outOfStock: 'نفذت الكمية',
    adding: 'بنضيف...',
  },
};

/**
 * Add to Cart button with loading states, stock status, and accessibility.
 */
export const AddToCartButton = forwardRef<HTMLButtonElement, AddToCartButtonProps>(
  (
    {
      productId,
      inStock = true,
      quantityInCart = 0,
      isRtl = false,
      onAddToCart,
      labels: customLabels,
      showQuantityBadge = true,
      variant = 'default',
      iconOnly = false,
      className,
      disabled,
      ...props
    },
    ref
  ) => {
    const [isLoading, setIsLoading] = useState(false);
    const [isAdded, setIsAdded] = useState(false);

    const labels = {
      ...defaultLabels[isRtl ? 'ar' : 'en'],
      ...customLabels,
    };

    const handleClick = async () => {
      if (!inStock || isLoading || disabled) return;

      setIsLoading(true);
      try {
        await onAddToCart?.(productId);
        setIsAdded(true);
        setTimeout(() => setIsAdded(false), 2000);
      } finally {
        setIsLoading(false);
      }
    };

    const isDisabled = !inStock || disabled;
    const showBadge = showQuantityBadge && quantityInCart > 0 && !iconOnly;

    const getLabel = () => {
      if (!inStock) return labels.outOfStock;
      if (isLoading) return labels.adding;
      if (isAdded) return labels.addedToCart;
      return labels.addToCart;
    };

    const CartIconEl = () => (
      <CartIcon
        className={cn('w-5 h-5', !iconOnly && (isRtl ? 'ml-2' : 'mr-2'))}
        aria-hidden="true"
      />
    );

    const LoadingSpinner = () => (
      <svg
        className={cn('w-5 h-5 animate-spin', !iconOnly && (isRtl ? 'ml-2' : 'mr-2'))}
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    );

    const CheckIcon = () => (
      <svg
        className={cn('w-5 h-5', !iconOnly && (isRtl ? 'ml-2' : 'mr-2'))}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );

    if (iconOnly) {
      return (
        <button
          ref={ref}
          onClick={handleClick}
          disabled={isDisabled}
          // data-zone="cta" routes the per-store typography sub-zone
          // for buttons / CTAs to every Add-to-Cart instance across
          // the storefront, regardless of which template renders it.
          data-zone="cta"
          className={cn(
            'relative flex items-center justify-center w-10 h-10 rounded-full transition-all',
            'bg-primary text-primary-foreground hover:bg-primary/90',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
            isAdded && 'bg-green-500 hover:bg-green-500',
            className
          )}
          aria-label={getLabel()}
          aria-busy={isLoading}
          {...props}
        >
          {isLoading ? <LoadingSpinner /> : isAdded ? <CheckIcon /> : <CartIconEl />}
          {showQuantityBadge && quantityInCart > 0 && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 text-xs font-bold bg-red-500 text-white rounded-full">
              {quantityInCart > 9 ? '9+' : quantityInCart}
            </span>
          )}
        </button>
      );
    }

    return (
      <Button
        ref={ref}
        onClick={handleClick}
        disabled={isDisabled}
        variant={variant === 'default' ? 'default' : variant === 'outline' ? 'outline' : 'ghost'}
        // See comment on the iconOnly branch above — same data-zone tag.
        data-zone="cta"
        className={cn(
          // `whitespace-nowrap` keeps Arabic labels like "إضافة للسلة"
          // on a single line. Without it, narrow product-card columns
          // wrap the label across two lines.
          'relative whitespace-nowrap',
          isAdded && 'bg-green-500 hover:bg-green-500 border-green-500',
          className
        )}
        aria-busy={isLoading}
        {...props}
      >
        {isLoading ? <LoadingSpinner /> : isAdded ? <CheckIcon /> : <CartIconEl />}
        <span>{getLabel()}</span>
        {showBadge && (
          <span className="absolute -top-2 -right-2 flex items-center justify-center w-5 h-5 text-xs font-bold bg-red-500 text-white rounded-full">
            {quantityInCart > 9 ? '9+' : quantityInCart}
          </span>
        )}
      </Button>
    );
  }
);

AddToCartButton.displayName = 'AddToCartButton';
