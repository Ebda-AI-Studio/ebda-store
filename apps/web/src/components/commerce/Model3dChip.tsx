'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeatures } from '@/contexts/FeatureContext';

/**
 * The quick view (Sheet + viewer + product fetch) is a lazy chunk: a listing page pays for the
 * chip only, and the quick view code is fetched the first time a shopper taps one (LCP budget).
 */
const Model3dQuickView = dynamic(() => import('./Model3dQuickView'), {
  ssr: false,
  loading: () => null,
});

function useLanguageOrArabic(): 'ar' | 'en' {
  try {
    return useLanguage().language === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

function use3dEnabled(): boolean {
  try {
    return useFeatures().isEnabled('product_3d');
  } catch {
    // No FeatureProvider (an isolated render): the API already gated the flag it ships.
    return true;
  }
}

/**
 * "3D" tag on a product card, only when the product has a model (`has3d`, from the listing /
 * recommendation / wishlist payloads) and the store has `product_3d`. A tap opens the quick view.
 *
 * It is a `<span>`, not a button: on most card paths it sits inside the card's `<Link>`, and a
 * button inside an anchor is invalid HTML. The click handler cancels that navigation and opens
 * the quick view; a keyboard user follows the card link to the product page, which has the same
 * 3D toggle (nothing is lost, and there is no nested-interactive element).
 */
export function Model3dChip({
  product,
  className = '',
}: {
  product: { slug: string; name: string; nameAr?: string | null; has3d?: boolean };
  className?: string;
}) {
  const lang = useLanguageOrArabic();
  const enabled = use3dEnabled();
  const [open, setOpen] = useState(false);
  if (!product.has3d || !enabled) return null;
  const label = lang === 'ar' ? 'موديل 3D' : '3D model';
  return (
    <>
      <span
        data-card-chrome="tags"
        data-testid="model3d-chip"
        title={lang === 'ar' ? 'شوفه 3D' : 'View in 3D'}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={`relative flex w-fit min-h-6 cursor-pointer items-center gap-1 rounded-[var(--radius)] border border-foreground/15 px-1.5 py-0.5 text-xs font-semibold leading-normal text-foreground transition-colors motion-reduce:transition-none before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-[''] hover:border-foreground/40 hover:bg-foreground/5 active:bg-foreground/10 ${className}`.trim()}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5"
          />
        </svg>
        <span aria-hidden="true">3D</span>
        <span className="sr-only">{label}</span>
      </span>
      {open ? (
        <Model3dQuickView
          slug={product.slug}
          fallbackName={lang === 'ar' ? product.nameAr || product.name : product.name}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
