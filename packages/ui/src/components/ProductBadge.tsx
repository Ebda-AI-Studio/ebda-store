'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';
import { formatSigned } from '@ebda/shared';

export type ProductBadgeVariant =
  | 'sale'
  | 'new'
  | 'soldOut'
  | 'featured'
  | 'limited'
  | 'bestseller'
  | 'custom';

export interface ProductBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Badge variant */
  variant: ProductBadgeVariant;
  /** Discount percentage (for sale variant) */
  discount?: number;
  /** Custom label text (overrides default) */
  label?: string;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Position for absolute positioning */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Use absolute positioning */
  absolute?: boolean;
}

const variantStyles: Record<ProductBadgeVariant, string> = {
  sale: 'bg-red-500 text-white',
  new: 'bg-primary text-primary-foreground',
  soldOut: 'bg-gray-500 text-white',
  featured: 'bg-yellow-500 text-yellow-900',
  limited: 'bg-purple-500 text-white',
  bestseller: 'bg-green-500 text-white',
  custom: 'bg-primary text-primary-foreground',
};

const sizeStyles = {
  sm: 'text-xs px-1.5 py-0.5',
  md: 'text-xs px-2 py-1',
  lg: 'text-sm px-2.5 py-1',
};

const positionStyles = {
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
  'bottom-left': 'bottom-2 left-2',
  'bottom-right': 'bottom-2 right-2',
};

const defaultLabels = {
  en: {
    sale: 'Sale',
    new: 'New',
    soldOut: 'Sold Out',
    featured: 'Featured',
    limited: 'Limited',
    bestseller: 'Bestseller',
    custom: '',
  },
  ar: {
    sale: 'تخفيض',
    new: 'جديد',
    soldOut: 'نفذ',
    featured: 'مميز',
    limited: 'محدود',
    bestseller: 'الأكثر مبيعاً',
    custom: '',
  },
};

/**
 * Product badge for displaying status like sale, new, sold out, etc.
 */
export const ProductBadge = forwardRef<HTMLSpanElement, ProductBadgeProps>(
  (
    {
      variant,
      discount,
      label,
      isRtl = false,
      size = 'md',
      position = 'top-left',
      absolute = false,
      className,
      ...props
    },
    ref
  ) => {
    const getLabel = () => {
      if (label) return label;

      if (variant === 'sale' && discount) {
        return isRtl ? `${discount}% خصم` : formatSigned(-discount, { format: abs => `${abs}%` });
      }

      return defaultLabels[isRtl ? 'ar' : 'en'][variant] || '';
    };

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center font-bold rounded-full whitespace-nowrap',
          variantStyles[variant],
          sizeStyles[size],
          absolute && 'absolute z-10',
          absolute && positionStyles[position],
          isRtl && absolute && position.includes('left') && 'left-auto right-2',
          isRtl && absolute && position.includes('right') && 'right-auto left-2',
          className
        )}
        {...props}
      >
        {getLabel()}
      </span>
    );
  }
);

ProductBadge.displayName = 'ProductBadge';

/**
 * Container for multiple product badges with proper spacing
 */
export interface ProductBadgeGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Position for absolute positioning */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Use absolute positioning */
  absolute?: boolean;
  /** Show in RTL format */
  isRtl?: boolean;
}

export const ProductBadgeGroup = forwardRef<HTMLDivElement, ProductBadgeGroupProps>(
  (
    { position = 'top-left', absolute = false, isRtl = false, className, children, ...props },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-1.5',
          absolute && 'absolute z-10',
          absolute && positionStyles[position],
          isRtl && absolute && position.includes('left') && 'left-auto right-2',
          isRtl && absolute && position.includes('right') && 'right-auto left-2',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ProductBadgeGroup.displayName = 'ProductBadgeGroup';
