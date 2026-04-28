'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import type { ProductCarouselProps } from '../types';

/**
 * Horizontal-scroll product strip. Card chrome + CTA pill style vary per pack:
 *   - Modern: rounded-2xl soft shadow + rounded-full pill CTA
 *   - Classic: sharp border + serif uppercase pill CTA
 *   - Minimal: no chrome + underlined "Add to cart" link CTA
 *   - Bold: 2px border + black uppercase block CTA
 *   - Elegant: hairline border + serif extralight outlined CTA
 *
 * Per Pecannbee deviation: we **show name + price** (Pecannbee hides them
 * with CSS for a B2B feel; B2C default keeps them visible).
 *
 * Behavior: prev/next arrows nudge by one card width; autoplay rotates the
 * strip every 4s, pauses on hover/touch, respects prefers-reduced-motion,
 * and loops back to the start when it reaches the end.
 */
export function ProductCarousel({
  products,
  title,
  titleAr,
  seeAllHref,
  isRtl,
  currency = 'KWD',
  onAddToCart,
  urlPrefix = '',
  pack,
}: ProductCarouselProps) {
  const styles = getPackStyles(pack);
  const scrollRef = useRef<HTMLUListElement>(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Update arrow visibility based on current scroll position. Uses scroll
  // events so we don't have to know card widths up front.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      // RTL flips the sign of scrollLeft in some engines; abs() normalises.
      const pos = Math.abs(el.scrollLeft);
      setCanScrollPrev(pos > 4);
      setCanScrollNext(pos < max - 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [products.length]);

  // Autoplay — advance one viewport-width every 4s, looping back when we
  // hit the end. Suspended while the user hovers/touches the strip and
  // when prefers-reduced-motion is on.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || products.length <= 1 || isPaused) return;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    const id = window.setInterval(() => {
      const max = el.scrollWidth - el.clientWidth;
      const pos = Math.abs(el.scrollLeft);
      const nearEnd = pos >= max - 4;
      const direction = isRtl ? -1 : 1;
      if (nearEnd) {
        el.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: 'smooth' });
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [products.length, isPaused, isRtl]);

  const scrollByOneCard = (direction: 'prev' | 'next') => {
    const el = scrollRef.current;
    if (!el) return;
    // Approximate one card width (account for the gap-4/6/8). 24vw of
    // viewport is the average card width across breakpoints; we read the
    // first <li> for accuracy.
    const firstCard = el.querySelector('li');
    const step = firstCard ? firstCard.clientWidth + 24 : el.clientWidth * 0.45;
    const sign = (direction === 'next' ? 1 : -1) * (isRtl ? -1 : 1);
    el.scrollBy({ left: sign * step, behavior: 'smooth' });
  };

  if (products.length === 0) return null;

  return (
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
        />
        <div
          className="relative"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
          onTouchStart={() => setIsPaused(true)}
          onTouchEnd={() => setIsPaused(false)}
        >
          {/* Prev arrow — sits at the leading edge (left in LTR, right in
              RTL). Hidden on small screens where touch-scroll is the primary
              affordance, hidden when there's nothing to scroll back to. */}
          {canScrollPrev && (
            <button
              type="button"
              aria-label={isRtl ? 'التالي' : 'Previous'}
              onClick={() => scrollByOneCard('prev')}
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-border shadow-md hover:bg-muted text-foreground transition-colors cursor-pointer start-2"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={isRtl ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'}
                />
              </svg>
            </button>
          )}
          {/* Next arrow — trailing edge. */}
          {canScrollNext && (
            <button
              type="button"
              aria-label={isRtl ? 'السابق' : 'Next'}
              onClick={() => scrollByOneCard('next')}
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-border shadow-md hover:bg-muted text-foreground transition-colors cursor-pointer end-2"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={isRtl ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
                />
              </svg>
            </button>
          )}

          <ul
            ref={scrollRef}
            className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 sm:gap-6 lg:gap-8 scroll-smooth"
            style={{ scrollbarWidth: 'thin' }}
          >
            {products.map(product => {
              const name = isRtl ? (product.nameAr ?? product.name) : product.name;
              const href = `${urlPrefix}/products/${product.slug}`;
              const img = product.images?.[0]?.url;
              const onSale = product.compareAtPrice && product.compareAtPrice > product.price;

              return (
                <li
                  key={product.id}
                  className="snap-start shrink-0 w-[60vw] sm:w-[30vw] md:w-[24vw] lg:w-[20vw] xl:w-[18vw] max-w-[300px]"
                >
                  <div className={`overflow-hidden ${styles.card}`}>
                    <Link
                      href={href}
                      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <div className="group/img relative aspect-square overflow-hidden bg-muted">
                        {img ? (
                          <>
                            <Image
                              src={img}
                              alt={name}
                              fill
                              sizes="(max-width: 640px) 60vw, (max-width: 1024px) 30vw, 300px"
                              className="object-cover transition-opacity duration-500 group-hover/img:opacity-0"
                            />
                            {product.images?.[1]?.url && (
                              <Image
                                src={product.images[1].url}
                                alt={name}
                                fill
                                sizes="(max-width: 640px) 60vw, (max-width: 1024px) 30vw, 300px"
                                loading="lazy"
                                className="absolute inset-0 object-cover opacity-0 transition-opacity duration-500 group-hover/img:opacity-100"
                              />
                            )}
                          </>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                            <svg
                              className="h-10 w-10"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              aria-hidden
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.5}
                                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                              />
                            </svg>
                          </div>
                        )}
                        {onSale && (
                          <span className="absolute end-3 top-3 rounded-full bg-destructive px-2.5 py-1 text-xs font-bold text-destructive-foreground shadow-md">
                            -
                            {Math.round(
                              (1 - product.price / (product.compareAtPrice ?? product.price)) * 100
                            )}
                            %
                          </span>
                        )}
                      </div>
                      <div className={`px-5 py-5 space-y-2.5 ${styles.productCardBody ?? ''}`}>
                        <p className={`line-clamp-2 min-h-[3em] ${styles.productCardName}`}>
                          {name}
                        </p>
                        <div className="flex items-baseline gap-2">
                          <span className={styles.productCardPrice}>
                            {(product.price / 1000).toFixed(3)} {currency}
                          </span>
                          {onSale && product.compareAtPrice && (
                            <span className="text-sm text-muted-foreground line-through">
                              {(product.compareAtPrice / 1000).toFixed(3)}
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                    {onAddToCart && (
                      <button
                        type="button"
                        onClick={() => onAddToCart(product.id)}
                        className={`block w-full text-center cursor-pointer ${styles.productCardCta}`}
                      >
                        {isRtl ? 'إضافة للسلة' : 'Add to cart'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
