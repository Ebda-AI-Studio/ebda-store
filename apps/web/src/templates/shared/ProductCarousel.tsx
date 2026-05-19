'use client';

import type React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SectionHeading } from './SectionHeading';
import { getPackStyles } from './pack-styles';
import {
  cardAspectClass,
  cardFrameClass,
  cardFrameSizeClass,
  cardFrameWidthClass,
  cardShapeClasses,
  gridGapClass,
  productSizeClass,
} from './card-size';
import { OutOfStockRibbon, isProductNew } from './ProductCardCta';
import { BrandPill } from './BrandPill';
import { useStore } from '../../contexts/StoreContext';
import { getProductCardTextSizes, resolveColor } from '@force/shared';
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
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  showKickerLines,
  showSubtitleLines,
  seeAllHref,
  isRtl,
  currency = 'KWD',
  onAddToCart,
  urlPrefix = '',
  pack,
  cardSize,
  cardAspect,
  cardShape,
  cardGap,
  showLabel = true,
  showHover = true,
  showCardFrame,
  cardFrameStyle,
  cardFrameWidth,
  cardFrameSize,
  cardFrameColor,
  headingZone,
  kickerZone,
  subtitleZone,
  seeAllZone,
  productNameZone,
  productPriceZone,
  productCtaZone,
}: ProductCarouselProps) {
  const styles = getPackStyles(pack);
  const sizeCap = productSizeClass(cardSize);
  // Bucket E3 (2026-05-17): quick-add (+) circle is opt-in per store.
  // When `store.theme.showQuickAdd === true`, in-stock non-variant
  // products get the overlay button; otherwise it's hidden.
  const { store } = useStore();
  const showQuickAdd = store.theme?.showQuickAdd === true;
  // Sprint 1 (2026-05-17): per-cardSize text-size pair, paired with
  // pack-styles flavor classes. Without this the previous `text-lg`
  // names looked oversized inside `xs`/`sm` card widths and undersized
  // inside `lg`/`xl` widths.
  const textSizes = getProductCardTextSizes(cardSize);
  const shape = cardShapeClasses(cardShape);
  const aspectCls = shape.aspect || cardAspectClass(cardAspect) || 'aspect-square';
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
    // ProductCarousel is the primary "New Arrivals" + "Best Sellers"
    // surface on the homepage. Without this data-zone tag the
    // homepage product cards inherited template defaults instead of
    // the merchant's "Products" zone typography.
    <section className="px-4 sm:px-6 lg:px-8" dir={isRtl ? 'rtl' : 'ltr'} data-zone="products">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          kicker={kicker}
          kickerAr={kickerAr}
          subtitle={subtitle}
          subtitleAr={subtitleAr}
          showKickerLines={showKickerLines}
          showSubtitleLines={showSubtitleLines}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
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
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-foreground/10 shadow-[0_10px_24px_-12px_hsl(var(--foreground)/0.18)] hover:bg-muted text-foreground transition-all duration-300 ease-out cursor-pointer start-2"
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
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-foreground/10 shadow-[0_10px_24px_-12px_hsl(var(--foreground)/0.18)] hover:bg-muted text-foreground transition-all duration-300 ease-out cursor-pointer end-2"
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
            // touch-pan-x + overscroll-x-contain tell iOS Safari this
            // strip ONLY handles horizontal swipes — vertical swipes
            // bubble immediately to the page scroll without the typical
            // ~200ms direction-detect delay that felt like "scrolling
            // gets stuck then works" on the home page (Ahmad 2026-05-16).
            //
            // 2026-05-17: gap is now driven by the per-store cardGap
            // setting on newArrivals + bestSellers; the previous hard-
            // coded gap-4/6/8 ignored merchant saves entirely.
            className={`-mx-4 flex snap-x snap-mandatory ${gridGapClass(cardGap)} overflow-x-auto overscroll-x-contain touch-pan-x px-4 pb-4 scroll-smooth`}
            style={{ scrollbarWidth: 'thin' }}
          >
            {products.map(product => {
              const name = isRtl ? (product.nameAr ?? product.name) : product.name;
              const href = `${urlPrefix}/products/${product.slug}`;
              const img = product.images?.[0]?.url;
              const onSale = product.compareAtPrice && product.compareAtPrice > product.price;
              // Dual-CTA + OOS state for the carousel cards (platform-level
              // 2026-05-16). Products with variants can't add inline because
              // the carousel can't pick a variant — they get a "View" link
              // to the PDP instead. Out-of-stock products show a red ribbon
              // and disable the cart button.
              const hasVariants = !!product.variants && product.variants.length > 0;
              const inStock = product.inStock !== false;
              const showNewBadge = inStock && isProductNew(product);

              return (
                <li
                  key={product.id}
                  // Narrower mobile width so 2+ cards peek into the viewport,
                  // signalling the strip continues. Ahmad 2026-05-16: 'still
                  // products are huge'. 60vw → 44vw on mobile, slight tighten
                  // at sm. Desktop max cap now driven by per-store cardSize
                  // (xs/sm/md/lg/xl) so a merchant can shrink or grow product
                  // cards without theme code changes.
                  // showCardFrame (opt-in) adds rounded-2xl bg-card border +
                  // shadow around each card so they read as contained tiles.
                  className={`snap-start shrink-0 w-[44vw] sm:w-[28vw] md:w-[22vw] lg:w-[19vw] xl:w-[17vw] ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`}
                  style={
                    showCardFrame && cardFrameColor && store.theme
                      ? { borderColor: resolveColor(cardFrameColor, store.theme) }
                      : undefined
                  }
                >
                  {/* Sprint 2 (2026-05-17): hover-scale 1.02 on the card
                      frame for the same micro-payoff PecannbeeProductCard
                      now uses. Mobile loses nothing (no hover state). */}
                  <div
                    className={`overflow-hidden transition-all duration-500 ease-out md:hover:scale-[1.02] md:hover:shadow-[0_20px_40px_-20px_hsl(var(--foreground)/0.18)] ${shape.radius} ${styles.card}`}
                  >
                    <Link
                      href={href}
                      prefetch={false}
                      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <div
                        className={`group/img relative ${aspectCls} ${shape.radius} overflow-hidden bg-muted`}
                      >
                        <OutOfStockRibbon inStock={inStock} isRtl={isRtl} />
                        {/* Sprint 2: NEW orange pill top-START when new OR
                            <14 days old. Doesn't collide with OOS ribbon
                            because OOS hides NEW (see isProductNew gate). */}
                        {showNewBadge && (
                          <span
                            className="absolute top-3 start-3 z-10 rounded-full bg-[hsl(var(--primary))] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[hsl(var(--primary-foreground))] shadow-[0_6px_14px_-6px_hsl(var(--primary)/0.5)]"
                            aria-label={isRtl ? 'منتج جديد' : 'New product'}
                          >
                            {isRtl ? 'جديد' : 'NEW'}
                          </span>
                        )}
                        {/* Bucket C5: brand pill — hidden when OOS or
                            NEW already occupies the top-START corner. */}
                        <BrandPill hidden={!inStock || showNewBadge} />
                        {img ? (
                          <>
                            <Image
                              src={img}
                              alt={name}
                              fill
                              sizes="(max-width: 640px) 60vw, (max-width: 1024px) 30vw, 300px"
                              // Only fade out on hover when there's a second
                              // image to crossfade IN. Without this guard,
                              // single-image products go transparent on
                              // hover and reveal the empty bg-muted box.
                              className={`object-cover transition-opacity duration-500 ${
                                showHover && product.images?.[1]?.url
                                  ? 'group-hover/img:opacity-0'
                                  : ''
                              }`}
                            />
                            {showHover && product.images?.[1]?.url && (
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
                          <span className="absolute end-3 top-3 rounded-full bg-foreground/85 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-background shadow-[0_6px_16px_-6px_hsl(var(--foreground)/0.35)]">
                            -
                            {Math.round(
                              (1 - product.price / (product.compareAtPrice ?? product.price)) * 100
                            )}
                            %
                          </span>
                        )}
                        {/* Bucket E3 (2026-05-17): quick-add (+) circle button
                            overlay — Bank Alkahraman pattern. Single tap = add
                            to cart, no PDP navigation. Renders only when
                            opt-in flag is set + in-stock + not a variant
                            parent + onAddToCart handler present. Position
                            bottom-end of image so it doesn't fight the
                            wishlist heart top-start. */}
                        {showQuickAdd && inStock && !hasVariants && onAddToCart && (
                          <button
                            type="button"
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              onAddToCart(product.id);
                            }}
                            aria-label={isRtl ? 'إضافة للسلة' : 'Add to cart'}
                            className="absolute bottom-3 end-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_8px_20px_-6px_hsl(var(--primary)/0.5)] hover:scale-110 transition-transform cursor-pointer"
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
                                strokeWidth={2.5}
                                d="M12 4v16m8-8H4"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                      {/* Tightened p-5/p-6 → p-3/p-4 + dropped min-h-[3em]
                          name reservation per ahmad 2026-05-16 size pass.
                          Carousel cards on the homepage were the biggest
                          chrome offender. Whole block hides when the
                          merchant turns 'Show label' off in admin
                          (cardless / image-only product strips). */}
                      {showLabel && (
                        <div className={`p-3 sm:p-4 space-y-2 ${styles.productCardBody ?? ''}`}>
                          <p
                            className={`line-clamp-2 ${textSizes.name} ${styles.productCardName}`}
                            data-zone="productName"
                            style={{
                              fontFamily: productNameZone?.fontFamily,
                              fontSize: productNameZone?.fontSize,
                              fontWeight: productNameZone?.fontWeight,
                              color: productNameZone?.color,
                              letterSpacing: productNameZone?.letterSpacing,
                              lineHeight: productNameZone?.lineHeight,
                              textTransform:
                                productNameZone?.textTransform as React.CSSProperties['textTransform'],
                            }}
                          >
                            {name}
                          </p>
                          <div
                            className={`flex items-baseline gap-2 ${styles.productCardBody ? 'justify-center' : ''}`}
                          >
                            <span
                              className={`${textSizes.price} ${styles.productCardPrice}`}
                              data-zone="productPrice"
                              style={{
                                fontFamily: productPriceZone?.fontFamily,
                                fontSize: productPriceZone?.fontSize,
                                fontWeight: productPriceZone?.fontWeight,
                                color: productPriceZone?.color,
                                letterSpacing: productPriceZone?.letterSpacing,
                                lineHeight: productPriceZone?.lineHeight,
                                textTransform:
                                  productPriceZone?.textTransform as React.CSSProperties['textTransform'],
                              }}
                            >
                              {(product.price / 1000).toFixed(3)} {currency}
                            </span>
                            {onSale && product.compareAtPrice && (
                              <span className="text-sm text-muted-foreground line-through">
                                {(product.compareAtPrice / 1000).toFixed(3)}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </Link>
                    {/* Platform-level dual CTA: variant products → View link
                        to PDP, single-variant products → Add to cart. OOS
                        forces a disabled button regardless.
                        Ahmad 2026-05-17: when showQuickAdd is on, the (+)
                        overlay above IS the addable affordance — hiding
                        the bottom Add-to-cart button removes the
                        redundancy. View + Out Of Stock buttons still
                        render because the (+) doesn't cover those cases. */}
                    {/* CTA zone inline style applied via a shared style object
                        so all three CTA variants (View / OOS / Add to cart)
                        reflect the merchant's productCta typography override. */}
                    {(() => {
                      const ctaStyle: React.CSSProperties = {
                        fontFamily: productCtaZone?.fontFamily,
                        fontSize: productCtaZone?.fontSize,
                        fontWeight: productCtaZone?.fontWeight,
                        color: productCtaZone?.color,
                        letterSpacing: productCtaZone?.letterSpacing,
                        lineHeight: productCtaZone?.lineHeight,
                        textTransform:
                          productCtaZone?.textTransform as React.CSSProperties['textTransform'],
                      };
                      return hasVariants ? (
                        <Link
                          href={href}
                          prefetch={false}
                          className={`block w-full text-center cursor-pointer ${styles.productCardCta}`}
                          data-zone="productCta"
                          style={ctaStyle}
                        >
                          {isRtl ? 'عرض' : 'View'}
                        </Link>
                      ) : !inStock ? (
                        <button
                          type="button"
                          disabled
                          className={`block w-full text-center opacity-60 cursor-not-allowed ${styles.productCardCta}`}
                          data-zone="productCta"
                          style={ctaStyle}
                        >
                          {isRtl ? 'نفدت الكمية' : 'Out Of Stock'}
                        </button>
                      ) : (
                        !showQuickAdd &&
                        onAddToCart && (
                          <button
                            type="button"
                            onClick={() => onAddToCart(product.id)}
                            className={`block w-full text-center cursor-pointer ${styles.productCardCta}`}
                            data-zone="productCta"
                            style={ctaStyle}
                          >
                            {isRtl ? 'إضافة للسلة' : 'Add to cart'}
                          </button>
                        )
                      );
                    })()}
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
