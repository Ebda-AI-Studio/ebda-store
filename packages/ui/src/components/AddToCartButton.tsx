'use client';

import { forwardRef, useState } from 'react';
import { cn } from '../utils/cn';
import { Button, type ButtonProps } from './Button';

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
    addedToCart: 'تمت الإضافة!',
    outOfStock: 'نفذت الكمية',
    adding: 'جاري الإضافة...',
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

    const CartIcon = () => (
      <svg
        className={cn('w-5 h-5', !iconOnly && (isRtl ? 'ml-2' : 'mr-2'))}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
        />
      </svg>
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
          {isLoading ? <LoadingSpinner /> : isAdded ? <CheckIcon /> : <CartIcon />}
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
        className={cn(
          'relative',
          isAdded && 'bg-green-500 hover:bg-green-500 border-green-500',
          className
        )}
        aria-busy={isLoading}
        {...props}
      >
        {isLoading ? <LoadingSpinner /> : isAdded ? <CheckIcon /> : <CartIcon />}
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
