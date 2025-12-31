'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';

export interface QuantitySelectorProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange'
> {
  /** Current quantity value */
  value: number;
  /** Callback when quantity changes */
  onChange: (value: number) => void;
  /** Minimum allowed quantity */
  min?: number;
  /** Maximum allowed quantity */
  max?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Disable the selector */
  disabled?: boolean;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Show stock warning when near max */
  showStockWarning?: boolean;
  /** Stock warning threshold */
  stockWarningThreshold?: number;
  /** Custom aria label */
  ariaLabel?: string;
}

const sizeStyles = {
  sm: {
    button: 'w-7 h-7 text-sm',
    input: 'w-10 h-7 text-sm',
    container: 'h-7',
  },
  md: {
    button: 'w-9 h-9 text-base',
    input: 'w-12 h-9 text-base',
    container: 'h-9',
  },
  lg: {
    button: 'w-11 h-11 text-lg',
    input: 'w-14 h-11 text-lg',
    container: 'h-11',
  },
};

/**
 * Quantity selector with increment/decrement buttons and accessibility support.
 */
export const QuantitySelector = forwardRef<HTMLDivElement, QuantitySelectorProps>(
  (
    {
      value,
      onChange,
      min = 1,
      max = 99,
      size = 'md',
      disabled = false,
      isRtl = false,
      showStockWarning = true,
      stockWarningThreshold = 5,
      ariaLabel,
      className,
      ...props
    },
    ref
  ) => {
    const styles = sizeStyles[size];
    const canDecrement = value > min && !disabled;
    const canIncrement = value < max && !disabled;
    const showWarning = showStockWarning && max <= stockWarningThreshold && value === max;

    const handleDecrement = () => {
      if (canDecrement) {
        onChange(value - 1);
      }
    };

    const handleIncrement = () => {
      if (canIncrement) {
        onChange(value + 1);
      }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10);
      if (!isNaN(newValue)) {
        onChange(Math.max(min, Math.min(max, newValue)));
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleIncrement();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleDecrement();
      }
    };

    return (
      <div ref={ref} className={cn('flex flex-col gap-1', className)} {...props}>
        <div
          className={cn(
            'inline-flex items-center rounded-lg border border-border bg-background',
            disabled && 'opacity-50 cursor-not-allowed',
            styles.container
          )}
          role="group"
          aria-label={ariaLabel || (isRtl ? 'اختيار الكمية' : 'Quantity selector')}
        >
          {/* Decrement Button */}
          <button
            type="button"
            onClick={handleDecrement}
            disabled={!canDecrement}
            className={cn(
              'flex items-center justify-center rounded-l-lg transition-colors',
              'hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
              isRtl && 'rounded-l-none rounded-r-lg order-3',
              styles.button
            )}
            aria-label={isRtl ? 'تقليل الكمية' : 'Decrease quantity'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>

          {/* Quantity Input */}
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className={cn(
              'text-center font-medium bg-transparent border-x border-border',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
              'disabled:cursor-not-allowed',
              isRtl && 'order-2',
              styles.input
            )}
            aria-label={isRtl ? 'الكمية' : 'Quantity'}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
          />

          {/* Increment Button */}
          <button
            type="button"
            onClick={handleIncrement}
            disabled={!canIncrement}
            className={cn(
              'flex items-center justify-center rounded-r-lg transition-colors',
              'hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
              isRtl && 'rounded-r-none rounded-l-lg order-1',
              styles.button
            )}
            aria-label={isRtl ? 'زيادة الكمية' : 'Increase quantity'}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>

        {/* Stock Warning */}
        {showWarning && (
          <span className="text-xs text-orange-600 dark:text-orange-400">
            {isRtl ? `${max} قطع متبقية فقط` : `Only ${max} left in stock`}
          </span>
        )}
      </div>
    );
  }
);

QuantitySelector.displayName = 'QuantitySelector';
