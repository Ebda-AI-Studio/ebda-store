'use client';

/**
 * Shared compare + wishlist-remove buttons used by every template's
 * ProductCard. Each button is rendered only when the corresponding handler
 * prop is provided on the card. Styling uses theme tokens so each template
 * automatically inherits the tenant's colors; the button shape is neutral
 * enough that bold / elegant / minimal / etc. all look at home with it.
 */

export type CardActionKind = 'wishlist-add' | 'wishlist-remove' | 'compare-add' | 'compare-remove';

/**
 * a11y P2-5: a page of cards must not expose a dozen buttons with one name, so
 * each per-card action carries the product. Without a name the generic label.
 */
export function cardActionLabel(kind: CardActionKind, isRtl: boolean, name?: string): string {
  const n = name?.trim();
  switch (kind) {
    case 'wishlist-add':
      return isRtl
        ? n
          ? `إضافة ${n} إلى المفضلة`
          : 'إضافة للمفضلة'
        : n
          ? `Add ${n} to wishlist`
          : 'Add to wishlist';
    case 'wishlist-remove':
      return isRtl
        ? n
          ? `إزالة ${n} من المفضلة`
          : 'إزالة من المفضلة'
        : n
          ? `Remove ${n} from wishlist`
          : 'Remove from wishlist';
    case 'compare-add':
      return isRtl
        ? n
          ? `إضافة ${n} إلى المقارنة`
          : 'إضافة إلى المقارنة'
        : n
          ? `Add ${n} to compare`
          : 'Add to compare';
    case 'compare-remove':
      return isRtl
        ? n
          ? `إزالة ${n} من المقارنة`
          : 'إزالة من المقارنة'
        : n
          ? `Remove ${n} from compare`
          : 'Remove from compare';
  }
}

interface CompareButtonProps {
  productId: string;
  isInCompare?: boolean;
  onToggle: (productId: string) => void;
  isRtl?: boolean;
  /** The product's display name, so each card's button is distinct (a11y P2-5). */
  productName?: string;
  /** tailwind position class, default `top-3`; override to place in a strip. */
  className?: string;
}

export function CompareButton({
  productId,
  isInCompare = false,
  onToggle,
  isRtl = false,
  productName,
  className = '',
}: CompareButtonProps) {
  // logical positioning — `start-3` flips automatically under [dir="rtl"]
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onToggle(productId);
      }}
      className={`absolute top-3 start-3 z-10 flex h-11 w-11 items-center justify-center rounded-full shadow-md backdrop-blur-sm transition-[background-color,color,transform] ${
        isInCompare
          ? 'bg-primary text-primary-foreground scale-105'
          : 'bg-background/95 text-muted-foreground hover:bg-background hover:text-foreground'
      } ${className}`}
      aria-label={cardActionLabel(
        isInCompare ? 'compare-remove' : 'compare-add',
        isRtl,
        productName
      )}
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
  /** The product's display name, so each card's button is distinct (a11y P2-5). */
  productName?: string;
  className?: string;
}

export function RemoveFromWishlistButton({
  productId,
  onRemove,
  isRtl = false,
  productName,
  className = '',
}: RemoveFromWishlistButtonProps) {
  // The remove button sits on the *opposite* side from CompareButton, so it
  // uses `end-3` (logical, flips under [dir="rtl"]).
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        onRemove(productId);
      }}
      className={`absolute top-3 end-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-background/95 text-destructive shadow-md backdrop-blur-sm transition-colors hover:bg-destructive hover:text-[hsl(var(--destructive-foreground))] ${className}`}
      aria-label={cardActionLabel('wishlist-remove', isRtl, productName)}
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
