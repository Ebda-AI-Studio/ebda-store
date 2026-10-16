'use client';

import { forwardRef, useState, useId } from 'react';
import { cn } from '../utils/cn';

export interface RatingProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Current rating value (0-5) */
  value: number;
  /** Total number of reviews */
  count?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show review count */
  showCount?: boolean;
  /** Show in RTL format */
  isRtl?: boolean;
  /** Interactive mode for user input */
  interactive?: boolean;
  /** Callback when rating changes (interactive mode) */
  onChange?: (value: number) => void;
  /** Show half stars */
  precision?: 0.5 | 1;
  /** Empty star color */
  emptyColor?: string;
  /** Filled star color */
  filledColor?: string;
  /** Custom count format */
  formatCount?: (count: number) => string;
}

const sizeStyles = {
  sm: {
    star: 'w-3.5 h-3.5',
    gap: 'gap-1',
    text: 'text-xs',
  },
  md: {
    star: 'w-4 h-4',
    gap: 'gap-1',
    text: 'text-sm',
  },
  lg: {
    star: 'w-5 h-5',
    gap: 'gap-1.5',
    text: 'text-base',
  },
};

const StarIcon = ({
  filled,
  half,
  size,
  filledColor,
  emptyColor,
  gradientId,
}: {
  filled: boolean;
  half?: boolean;
  size: string;
  filledColor: string;
  emptyColor: string;
  gradientId: string;
}) => {
  if (half) {
    return (
      <svg className={size} viewBox="0 0 20 20" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId}>
            <stop offset="50%" stopColor={filledColor} />
            <stop offset="50%" stopColor={emptyColor} />
          </linearGradient>
        </defs>
        <path
          fill={`url(#${gradientId})`}
          d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"
        />
      </svg>
    );
  }

  return (
    <svg
      className={cn(size, filled ? 'text-amber-400' : 'text-gray-300')}
      fill="currentColor"
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
    </svg>
  );
};

/**
 * Star rating display and input component.
 */
export const Rating = forwardRef<HTMLDivElement, RatingProps>(
  (
    {
      value,
      count,
      size = 'md',
      showCount = true,
      isRtl = false,
      interactive = false,
      onChange,
      precision = 1,
      emptyColor: _emptyColor = 'currentColor',
      filledColor: _filledColor = 'currentColor',
      formatCount,
      className,
      ...props
    },
    ref
  ) => {
    const [hoverValue, setHoverValue] = useState<number | null>(null);
    const gradientId = useId();
    const styles = sizeStyles[size];
    const displayValue = hoverValue ?? value;

    const handleMouseEnter = (index: number) => {
      if (interactive) {
        setHoverValue(index + 1);
      }
    };

    const handleMouseLeave = () => {
      if (interactive) {
        setHoverValue(null);
      }
    };

    const handleClick = (index: number) => {
      if (interactive && onChange) {
        onChange(index + 1);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
      if (!interactive || !onChange) return;

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onChange(index + 1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        onChange(Math.min(5, value + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        onChange(Math.max(1, value - 1));
      }
    };

    const getStarState = (index: number) => {
      if (precision === 0.5) {
        if (index + 1 <= displayValue) return 'filled';
        if (index + 0.5 <= displayValue) return 'half';
        return 'empty';
      }
      return index < Math.round(displayValue) ? 'filled' : 'empty';
    };

    const formattedCount = formatCount
      ? formatCount(count ?? 0)
      : count !== undefined
        ? `(${count})`
        : null;

    return (
      <div
        ref={ref}
        className={cn(
          'inline-flex items-center',
          styles.gap,
          interactive && 'cursor-pointer',
          className
        )}
        dir={isRtl ? 'rtl' : 'ltr'}
        role={interactive ? 'radiogroup' : 'img'}
        aria-label={isRtl ? `تقييم ${value} من 5 نجوم` : `Rating: ${value} out of 5 stars`}
        {...props}
      >
        <div className={cn('flex items-center', styles.gap)}>
          {[...Array(5)].map((_, index) => {
            const starState = getStarState(index);

            return (
              <span
                key={index}
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseLeave={handleMouseLeave}
                onClick={() => handleClick(index)}
                onKeyDown={e => handleKeyDown(e, index)}
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? 'radio' : undefined}
                aria-checked={interactive ? index + 1 === value : undefined}
                className={cn(
                  interactive &&
                    'transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 rounded'
                )}
              >
                <StarIcon
                  filled={starState === 'filled'}
                  half={starState === 'half'}
                  size={styles.star}
                  filledColor={starState !== 'empty' ? 'rgb(251 191 36)' : 'rgb(209 213 219)'}
                  emptyColor="rgb(209 213 219)"
                  gradientId={`${gradientId}-half-${index}`}
                />
              </span>
            );
          })}
        </div>

        {showCount && formattedCount && (
          <span className={cn('text-muted-foreground tabular-nums', styles.text)}>
            {formattedCount}
          </span>
        )}
      </div>
    );
  }
);

Rating.displayName = 'Rating';

/**
 * Compact rating display showing average and count
 */
export interface RatingSummaryProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Average rating (0-5) */
  average: number;
  /** Total number of reviews */
  count: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show in RTL format */
  isRtl?: boolean;
}

export const RatingSummary = forwardRef<HTMLDivElement, RatingSummaryProps>(
  ({ average, count, size = 'md', isRtl = false, className, ...props }, ref) => {
    const summaryGradientId = useId();
    const styles = sizeStyles[size];

    return (
      <div
        ref={ref}
        className={cn('inline-flex items-center gap-1', className)}
        dir={isRtl ? 'rtl' : 'ltr'}
        {...props}
      >
        <StarIcon
          filled
          size={styles.star}
          filledColor="rgb(251 191 36)"
          emptyColor="rgb(209 213 219)"
          gradientId={summaryGradientId}
        />
        <span className={cn('font-medium', styles.text)}>{average.toFixed(1)}</span>
        <span className={cn('text-muted-foreground', styles.text)}>({count})</span>
      </div>
    );
  }
);

RatingSummary.displayName = 'RatingSummary';
