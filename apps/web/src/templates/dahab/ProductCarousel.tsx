'use client';

/**
 * Dahab product row: a scroll-snap strip (swipe on phones, arrow buttons on
 * pointer devices). Same props as the shared carousel so the page renderer
 * and the product page call it unchanged; the per-card size/frame knobs of
 * the other packs do not apply to this skin — Dahab cards are one size, and
 * the row sets the density (cards per view). It reads Show name and Hover
 * effect (Ruling B5-35).
 */
import { useRef } from 'react';
import type { ProductCarouselProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import DahabProductCard from './ProductCard';
import { ChevronIcon, DAHAB_CONTAINER, DahabSectionHeading, pick } from './ui';
import { CARD_CAROUSEL_SIZES } from '../../lib/image-sizes';

export function DahabProductCarousel({
  products,
  title,
  titleAr,
  subtitle,
  subtitleAr,
  seeAllHref,
  isRtl: isRtlProp,
  onAddToCart,
  urlPrefix = '',
  showCardName,
  showCardPrice,
  showLabel,
  showHover,
}: ProductCarouselProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const track = useRef<HTMLDivElement>(null);
  if (products.length === 0) return null;

  // scrollBy is physical; in RTL the inline-end lies to the left.
  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const amount = el.clientWidth * 0.8 * dir * (isRtl ? -1 : 1);
    el.scrollBy({ left: amount, behavior: 'smooth' });
  };

  return (
    <div className={DAHAB_CONTAINER}>
      <div className="relative">
        <DahabSectionHeading
          title={pick(isRtl, title, titleAr)}
          subtitle={pick(isRtl, subtitle, subtitleAr) || undefined}
          actionLabel={seeAllHref ? t('View all', 'عرض الكل') : undefined}
          actionHref={seeAllHref}
        />
      </div>
      <div className="relative">
        <div
          ref={track}
          className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:gap-5 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:scroll-px-0 lg:px-0 [&::-webkit-scrollbar]:hidden"
          role="list"
        >
          {products.map(product => (
            <div
              key={product.id}
              role="listitem"
              className="w-[46%] shrink-0 snap-start sm:w-[31%] lg:w-[calc((100%-3*1.25rem)/4)]"
            >
              <DahabProductCard
                product={product}
                isRtl={isRtl}
                onAddToCart={onAddToCart}
                urlPrefix={urlPrefix}
                showCardName={showCardName}
                showCardPrice={showCardPrice}
                showLabel={showLabel}
                showHover={showHover}
                imageSizes={CARD_CAROUSEL_SIZES}
              />
            </div>
          ))}
        </div>
        {products.length > 4 && (
          <div className="pointer-events-none absolute inset-x-0 top-[calc((100%-4.5rem)/2)] hidden justify-between lg:flex">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label={t('Previous', 'السابق')}
              className="pointer-events-auto -ms-5 flex h-11 w-11 items-center justify-center rounded-full border border-input bg-background text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronIcon className="h-4 w-4 rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label={t('Next', 'التالي')}
              className="pointer-events-auto -me-5 flex h-11 w-11 items-center justify-center rounded-full border border-input bg-background text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronIcon className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
