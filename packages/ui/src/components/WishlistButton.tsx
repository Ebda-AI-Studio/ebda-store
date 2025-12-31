'use client';

import { forwardRef, useState } from 'react';
import { cn } from '../utils/cn';

export interface WishlistButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'onToggle'
> {
  /** Product ID */
  productId: string;
  /** Whether the item is already in wishlist */
  isWishlisted?: boolean;
  /** Callback when wishlist state changes */
  onToggle?: (productId: string, isWishlisted: boolean) => Promise<void> | void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'default' | 'outline' | 'ghost' | 'floating';
  /** Show in RTL format */
  isRtl?: boolean;
  /** Show label text */
  showLabel?: boolean;
  /** Custom labels */
  labels?: {
    add?: string;
    remove?: string;
    adding?: string;
  };
}

const sizeStyles = {
  sm: {
    button: 'w-8 h-8',
    icon: 'w-4 h-4',
    text: 'text-xs',
  },
  md: {
    button: 'w-10 h-10',
    icon: 'w-5 h-5',
    text: 'text-sm',
  },
  lg: {
    button: 'w-12 h-12',
    icon: 'w-6 h-6',
    text: 'text-base',
  },
};

const variantStyles = {
  default: 'bg-background border border-border hover:bg-muted',
  outline: 'bg-transparent border-2 border-current hover:bg-muted/20',
  ghost: 'bg-transparent hover:bg-muted/50',
  floating: 'bg-background/90 backdrop-blur-sm shadow-lg hover:bg-background',
};

const defaultLabels = {
  en: {
    add: 'Add to Wishlist',
    remove: 'Remove from Wishlist',
    adding: 'Adding...',
  },
  ar: {
    add: 'أضف للمفضلة',
    remove: 'إزالة من المفضلة',
    adding: 'جاري الإضافة...',
  },
};

/**
 * Wishlist toggle button with heart icon and loading states.
 */
export const WishlistButton = forwardRef<HTMLButtonElement, WishlistButtonProps>(
  (
    {
      productId,
      isWishlisted: controlledWishlisted,
      onToggle,
      size = 'md',
      variant = 'default',
      isRtl = false,
      showLabel = false,
      labels: customLabels,
      className,
      disabled,
      ...props
    },
    ref
  ) => {
    const [internalWishlisted, setInternalWishlisted] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Support both controlled and uncontrolled modes
    const isWishlisted = controlledWishlisted ?? internalWishlisted;

    const labels = {
      ...defaultLabels[isRtl ? 'ar' : 'en'],
      ...customLabels,
    };

    const styles = sizeStyles[size];

    const handleClick = async () => {
      if (disabled || isLoading) return;

      setIsLoading(true);
      try {
        const newState = !isWishlisted;
        await onToggle?.(productId, newState);
        // Update internal state if uncontrolled
        if (controlledWishlisted === undefined) {
          setInternalWishlisted(newState);
        }
      } finally {
        setIsLoading(false);
      }
    };

    const label = isLoading ? labels.adding : isWishlisted ? labels.remove : labels.add;

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        disabled={disabled || isLoading}
        className={cn(
          'inline-flex items-center justify-center rounded-full transition-all duration-200',
          'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          variantStyles[variant],
          !showLabel && styles.button,
          showLabel && 'px-4 py-2 gap-2',
          className
        )}
        aria-label={label}
        aria-pressed={isWishlisted}
        {...props}
      >
        {isLoading ? (
          <svg
            className={cn('animate-spin', styles.icon)}
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
        ) : (
          <svg
            className={cn(
              styles.icon,
              'transition-colors duration-200',
              isWishlisted ? 'text-red-500 fill-red-500' : 'text-current'
            )}
            fill={isWishlisted ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
            />
          </svg>
        )}
        {showLabel && <span className={styles.text}>{label}</span>}
      </button>
    );
  }
);

WishlistButton.displayName = 'WishlistButton';
