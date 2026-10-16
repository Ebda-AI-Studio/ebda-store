'use client';

import { useStore } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

interface BrandPillProps {
  /** Force-hide the pill (caller may already have an OOS ribbon or NEW
   *  badge in the same corner — preserves the no-collision invariant). */
  hidden?: boolean;
  className?: string;
}

/**
 * Bucket C5 (2026-05-17): opt-in brand pill rendered on product card
 * images when `store.theme.showBrandBadge === true`. Returns null when
 * disabled OR when the caller forces `hidden` (used to avoid corner
 * collision with OOS ribbon / NEW badge — both also live at top-START).
 *
 * Visual: small dark pill with the store name (or nameAr in RTL), 4px
 * radius, --accent background, white text, subtle shadow. Sized small
 * so it doesn't compete with the product image — strictly a brand-recall
 * accent, not a content element.
 */
export function BrandPill({ hidden = false, className = '' }: BrandPillProps) {
  const { store } = useStore();
  const { isRtl } = useLanguage();
  if (hidden) return null;
  if (store.theme?.showBrandBadge !== true) return null;
  const label = isRtl && store.nameAr ? store.nameAr : store.name;
  if (!label) return null;
  return (
    <span
      className={`absolute top-3 start-3 z-10 inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold tracking-wide bg-[hsl(var(--accent))]/95 text-[hsl(var(--accent-foreground))] shadow-[0_4px_10px_-4px_hsl(var(--foreground)/0.25)] backdrop-blur-sm pointer-events-none ${className}`}
      aria-hidden
    >
      {label}
    </span>
  );
}
