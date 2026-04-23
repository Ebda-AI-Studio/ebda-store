'use client';

/**
 * Shared compare + wishlist-remove buttons used by every template's
 * ProductCard. Each button is rendered only when the corresponding handler
 * prop is provided on the card. Styling uses theme tokens so each template
 * automatically inherits the tenant's colors; the button shape is neutral
 * enough that bold / elegant / minimal / etc. all look at home with it.
 */

interface CompareButtonProps {
  productId: string;
  isInCompare?: boolean;
  onToggle: (productId: string) => void;
  isRtl?: boolean;
  /** tailwind position class, default `top-3`; override to place in a strip. */
  className?: string;
}

export function CompareButton({
  productId,
  isInCompare = false,
  onToggle,
  isRtl = false,
  className = '',
}: CompareButtonProps) {
  const side = isRtl ? 'right-3' : 'left-3';
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(productId);
      }}
      className={`absolute top-3 ${side} z-10 flex h-9 w-9 items-center justify-center rounded-full shadow-md backdrop-blur-sm transition-all ${
        isInCompare
          ? 'bg-primary text-primary-foreground scale-105'
          : 'bg-background/95 text-muted-foreground hover:bg-background hover:text-foreground'
      } ${className}`}
      aria-label={
        isInCompare
          ? isRtl
            ? 'إزالة من المقارنة'
            : 'Remove from compare'
          : isRtl
            ? 'إضافة إلى المقارنة'
            : 'Add to compare'
      }
      aria-pressed={isInCompare}
      title={
        isInCompare
          ? isRtl
            ? 'إزالة من المقارنة'
            : 'Remove from compare'
          : isRtl
            ? 'إضافة إلى المقارنة'
            : 'Add to compare'
      }
    >
      <svg
        className="h-4 w-4"
        fill={isInCompare ? 'currentColor' : 'none'}
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={isInCompare ? 0 : 1.75}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
    </button>
  );
}

interface RemoveFromWishlistButtonProps {
  productId: string;
  onRemove: (productId: string) => void;
  isRtl?: boolean;
  className?: string;
}

export function RemoveFromWishlistButton({
  productId,
  onRemove,
  isRtl = false,
  className = '',
}: RemoveFromWishlistButtonProps) {
  const side = isRtl ? 'left-3' : 'right-3';
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onRemove(productId);
      }}
      className={`absolute top-3 ${side} z-10 flex h-9 w-9 items-center justify-center rounded-full bg-background/95 text-destructive shadow-md backdrop-blur-sm transition-all hover:bg-destructive hover:text-[hsl(var(--destructive-foreground))] ${className}`}
      aria-label={isRtl ? 'إزالة من المفضلة' : 'Remove from wishlist'}
      title={isRtl ? 'إزالة من المفضلة' : 'Remove from wishlist'}
    >
      <svg
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}
