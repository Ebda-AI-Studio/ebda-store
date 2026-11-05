'use client';

import { pickLocalizedName } from './display-helpers';
import { canBuyNow } from '@/lib/can-buy-now';
import type React from 'react';
import { resolveProductCardCtaOosDefaults } from './product-card-defaults';
import Image from 'next/image';
import Link from '../../components/StoreLink';
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
  lookCarouselLgWidth,
  productSizeClass,
  cardImageAspectClass,
  lookImageAspectClass,
  cardImageRadiusClass,
  ctaShapeClass,
  ctaSizeClass,
} from './card-size';
import { AdaptiveAddButton, OosImageDim, OutOfStockRibbon, isProductNew } from './ProductCardCta';
import { StorefrontProductCard } from './StorefrontProductCard';
import {
  lookCardCta,
  lookCtaVisible,
  QUIET_CARD_CTA_CLS,
  cardHoverCls,
  lookChip,
  LOOK_CHIP_CLS,
  LOOK_CHIP_STYLE,
} from './look-card';
import { smoothScrollLeftTo, smoothScrollLeftBy } from '@/lib/smooth-scroll';
import { BrandPill } from './BrandPill';
import { useStore } from '../../contexts/StoreContext';
import { useNumerals } from '../../hooks/useNumerals';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { getLook, getProductCardTextSizes, resolveColor } from '@ebda/shared';
import { cn } from '@ebda/ui';
import type { ProductCarouselProps } from '../types';
import { DahabProductCarousel } from '../dahab/ProductCarousel';
import { responsiveFontSize, guardedCtaColor } from './section-typography';
import { getDiscountBadgeText, isOnSale } from '../../lib/product-pricing';
import { getDiscountBadgeColor } from './discount-badge';
import { getCustomBadgeColor, getCustomBadgeTextColor, resolveCardBadges } from './custom-badge';
import { SwatchDots } from '../../components/commerce/SwatchDots';
import { FactChips } from '../../components/commerce/FactChips';
import { useRenderNow } from '../../contexts/RenderClockContext';
import { MissingImage } from './MissingImage';
import { CARD_CAROUSEL_SIZES } from '../../lib/image-sizes';

/**
 * Horizontal-scroll product strip. Card chrome + CTA pill style vary per pack:
 *   - Modern: rounded-2xl soft shadow + rounded-full pill CTA
 *   - Classic: sharp border + serif uppercase pill CTA
 *   - Minimal: no chrome + underlined "Add to cart" link CTA
 *   - Bold: 2px border + black uppercase block CTA
 *   - Elegant: hairline border + serif extralight outlined CTA
 *
 * Per Storefront deviation: we **show name + price** (Storefront hides them
 * with CSS for a B2B feel; B2C default keeps them visible).
 *
 * Behavior: prev/next arrows nudge by one card width; autoplay rotates the
 * strip every 4s, pauses on hover/touch, respects prefers-reduced-motion,
 * and loops back to the start when it reaches the end.
 */
function SharedProductCarousel({
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
  dividers,
  sectionBgColor,
  // Items 8/9 — image controls + label visibility
  cardImageAspect,
  cardImageRadius,
  showCardName,
  showCardPrice,
}: ProductCarouselProps) {
  const styles = getPackStyles(pack);
  const sizeCap = productSizeClass(cardSize);
  // Bucket E3 (2026-05-17): quick-add (+) circle is opt-in per store.
  // When `store.theme.showQuickAdd === true`, in-stock non-variant
  // products get the overlay button; otherwise it's hidden.
  const { store, layout } = useStore();
  const renderNow = useRenderNow();
  const { numerals } = useNumerals();
  // The ONE storefront price format ("1,490 ج.م" / "EGP 1,490", Ruling B1-28).
  const price = useLocalePrice();
  const showQuickAdd = store.theme?.showQuickAdd === true;
  // Item 4 (2026-07-12): when the merchant already has the outer showCardFrame
  // frame on AND opts into frameChromeDedup, suppress the inner pack-style
  // card chrome so cards show ONE frame instead of two nested ones. Default
  // (flag off/undefined) keeps today's doubled-frame rendering unchanged.
  const dedupInnerFrame = !!showCardFrame && store.theme?.frameChromeDedup === true;
  // Sprint 1 (2026-05-17): per-cardSize text-size pair, paired with
  // pack-styles flavor classes. Without this the previous `text-lg`
  // names looked oversized inside `xs`/`sm` card widths and undersized
  // inside `lg`/`xl` widths.
  const textSizes = getProductCardTextSizes(cardSize);

  // Task 3 B: read CTA + OOS defaults from productCardDefaults.
  const cardDefaults = layout?.productCardDefaults;
  const {
    resolvedCtaShape,
    resolvedCtaSize,
    resolvedCtaColor,
    resolvedCtaTextColor,
    resolvedCtaLabelTextEn,
    resolvedCtaLabelTextAr,
    resolvedOosDimColor,
    resolvedOosLabel,
    resolvedOosLabelTextEn,
    resolvedOosLabelTextAr,
    resolvedOosLabelShape,
    resolvedOosLabelPlacement,
    resolvedOosLabelColor,
    resolvedOosLabelTextColor,
    nameCase,
    viewOnly,
  } = resolveProductCardCtaOosDefaults(layout);
  // Discount/sale + custom badge styling — the per-product FINAL corner
  // decision (`resolveCardBadges`) happens inside the map below, since it
  // depends on that product's own label + stock state AND (issue #1609)
  // whether quick-add will actually render for THIS product.
  const discountBadgeColor = getDiscountBadgeColor(cardDefaults?.discountBadge?.color, store.theme);
  const customBadgeColor = getCustomBadgeColor(cardDefaults?.customBadge?.color, store.theme);
  // Look card tokens (W2b); all legacy on a store with no look.
  const lookCta = lookCardCta(store.theme, layout);
  const onLook = !!getLook(store.look);
  const ctaCls = lookCta === 'quiet' ? QUIET_CARD_CTA_CLS : styles.productCardCta;
  const chip = lookChip(store.theme);
  const customBadgeTextColor = getCustomBadgeTextColor(
    cardDefaults?.customBadge?.color,
    store.theme
  );
  // Build CTA extra classes for inline carousel CTA buttons.
  const ctaExtraCls = [ctaShapeClass(resolvedCtaShape), ctaSizeClass(resolvedCtaSize)]
    .filter(Boolean)
    .join(' ');
  const shape = cardShapeClasses(cardShape);
  // Match StorefrontProductCard + 4/5 theme cards so the same product isn't square
  // in a carousel but portrait in a category grid (audit: ratio consistency).
  const aspectCls =
    shape.aspect ||
    cardAspectClass(cardAspect) ||
    lookImageAspectClass(store.look) ||
    'aspect-square sm:aspect-[3/4]';

  // Item 8 — per-card image aspect + radius overrides.
  const imgAspectCls = cardImageAspectClass(cardImageAspect);
  const imgRadiusCls = cardImageRadiusClass(cardImageRadius);
  // Effective image aspect: explicit override wins, else shape/carousel default.
  const effectiveAspectCls = imgAspectCls || aspectCls;

  // Items 6 / 9 — price visibility: store-level toggle + per-card flag.
  // Single price-visibility control: productCardDefaults.showCardPrice
  // (the legacy theme.showPriceOnCards toggle was redundant and removed).
  const priceVisible = showCardPrice !== false;
  // Item 9 — name visibility.
  const nameVisible = showCardName !== false;
  // Item 10 — normalize images flag.
  const normalizeImages = store.theme?.normalizeProductImages === true;
  const scrollRef = useRef<HTMLUListElement>(null);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  // Rule (e) (W4, a11y P1-6): autoplay stops while focus is inside the strip and on a visible
  // toggle, not only on hover/touch. `canAutoplay` is read after mount (reduced motion is a
  // client fact), so the server markup and the first client render agree.
  const [focusPaused, setFocusPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [canAutoplay, setCanAutoplay] = useState(false);
  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setCanAutoplay(products.length > 1 && !reduced);
  }, [products.length]);
  const autoplayHeld = isPaused || focusPaused || userPaused;

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
    if (!el || !canAutoplay || autoplayHeld) return;

    const id = window.setInterval(() => {
      const max = el.scrollWidth - el.clientWidth;
      const pos = Math.abs(el.scrollLeft);
      const nearEnd = pos >= max - 4;
      const direction = isRtl ? -1 : 1;
      if (nearEnd) {
        smoothScrollLeftTo(el, 0);
      } else {
        smoothScrollLeftBy(el, direction * el.clientWidth * 0.9);
      }
    }, 4000);
    return () => window.clearInterval(id);
  }, [canAutoplay, autoplayHeld, isRtl]);

  const scrollByOneCard = (direction: 'prev' | 'next') => {
    const el = scrollRef.current;
    if (!el) return;
    // Approximate one card width (account for the gap-4/6/8). 24vw of
    // viewport is the average card width across breakpoints; we read the
    // first <li> for accuracy.
    const firstCard = el.querySelector('li');
    const step = firstCard ? firstCard.clientWidth + 24 : el.clientWidth * 0.45;
    const sign = (direction === 'next' ? 1 : -1) * (isRtl ? -1 : 1);
    smoothScrollLeftBy(el, sign * step);
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
          dividers={dividers}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
          sectionBgColor={sectionBgColor}
        />
        <div
          className="relative"
          data-autoplay={!canAutoplay ? 'off' : autoplayHeld ? 'paused' : 'running'}
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
          onTouchStart={() => setIsPaused(true)}
          onTouchEnd={() => setIsPaused(false)}
          onFocus={() => setFocusPaused(true)}
          onBlur={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusPaused(false);
          }}
        >
          {canAutoplay && (
            // PREMIUM-4: a small labelled control UNDER the strip at the inline end (it used to be a
            // bare 44px glyph floating beside "view all"). Rendered only when the strip auto-scrolls.
            <button
              type="button"
              data-autoplay-toggle
              aria-pressed={userPaused}
              onClick={() => setUserPaused(p => !p)}
              className="absolute -bottom-3 end-0 z-10 inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={
                userPaused
                  ? isRtl
                    ? 'تشغيل التمرير التلقائي'
                    : 'Play automatic scrolling'
                  : isRtl
                    ? 'إيقاف التمرير التلقائي'
                    : 'Pause automatic scrolling'
              }
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                {userPaused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}
              </svg>
              <span aria-hidden="true">
                {userPaused ? (isRtl ? 'تشغيل' : 'Play') : isRtl ? 'إيقاف' : 'Pause'}
              </span>
            </button>
          )}
          {/* Prev arrow — sits at the leading edge (left in LTR, right in
              RTL). Hidden on small screens where touch-scroll is the primary
              affordance, hidden when there's nothing to scroll back to. */}
          {canScrollPrev && (
            <button
              type="button"
              aria-label={isRtl ? 'السابق' : 'Previous'}
              onClick={() => scrollByOneCard('prev')}
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-foreground/10 shadow-[0_10px_24px_-12px_hsl(var(--foreground)/0.18)] hover:bg-muted text-foreground transition-colors duration-[var(--duration-base)] ease-[var(--ease-out)] cursor-pointer start-2"
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
              aria-label={isRtl ? 'التالي' : 'Next'}
              onClick={() => scrollByOneCard('next')}
              className="absolute top-1/2 -translate-y-1/2 z-10 hidden sm:flex h-11 w-11 items-center justify-center rounded-full bg-card border border-foreground/10 shadow-[0_10px_24px_-12px_hsl(var(--foreground)/0.18)] hover:bg-muted text-foreground transition-colors duration-[var(--duration-base)] ease-[var(--ease-out)] cursor-pointer end-2"
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
            data-part="product-grid"
            className={`-mx-4 flex justify-[safe_center] snap-x snap-mandatory ${gridGapClass(cardGap)} overflow-x-auto overscroll-x-contain touch-pan-x px-4 pb-4 scroll-smooth`}
            style={{ scrollbarWidth: 'thin' }}
          >
            {products.map((product, i) => {
              // IA-08 (W4): on a look store the strip renders the SAME shared card as the grid
              // (heart, name slot, chips, CTA token), so a page never shows two card dialects.
              if (onLook)
                return (
                  <li
                    key={product.id}
                    className={`snap-start shrink-0 w-[44vw] sm:w-[28vw] md:w-[22vw] ${lookCarouselLgWidth(cardGap)}`}
                  >
                    <StorefrontProductCard
                      product={product}
                      isRtl={isRtl}
                      pack={pack}
                      onAddToCart={onAddToCart}
                      urlPrefix={urlPrefix}
                      priority={i < 4}
                      cardImageAspect={cardImageAspect}
                      cardImageRadius={cardImageRadius}
                      showCardName={showCardName}
                      showCardPrice={showCardPrice}
                      productNameZone={productNameZone}
                      productPriceZone={productPriceZone}
                    />
                  </li>
                );
              const name = pickLocalizedName(product, Boolean(isRtl)) ?? product.name;
              const href = `${urlPrefix}/products/${product.slug}`;
              const img = product.images?.[0]?.url;
              const onSale = isOnSale(product);
              const discountBadgeText = getDiscountBadgeText(
                product,
                isRtl ?? false,
                undefined,
                undefined,
                numerals
              );
              // Dual-CTA + OOS state for the carousel cards (platform-level
              // 2026-05-16). Products with variants can't add inline because
              // the carousel can't pick a variant — they get a "View" link
              // to the PDP instead. Out-of-stock products show a red ribbon
              // and disable the cart button.
              const hasVariants = !!product.variants && product.variants.length > 0;
              const inStock = product.inStock !== false;
              // Task 13: backorder-aware orderable signal.
              const orderable = canBuyNow(product);
              const showNewBadge = inStock && isProductNew(product, renderNow, store.theme);
              // Issue #1609 — mirror the EXACT expression the quick-add
              // button below renders on, so a badge only lifts for a
              // product that will actually get a quick-add circle overlaid
              // on it.
              const showsQuickAddForThisProduct =
                showQuickAdd && orderable && !hasVariants && !viewOnly && Boolean(onAddToCart);
              // Badge mutex — single owner, same call as every other card
              // path. No label on this product = today's rendering exactly.
              const {
                customBadgeText,
                discountBadgeAllowed,
                customBadgePositionCls,
                discountBadgePositionCls,
                discountTopCorner,
              } = resolveCardBadges({
                discountVisible: Boolean(onSale && discountBadgeText),
                product,
                isRtl: isRtl ?? false,
                orderable,
                customPosition: cardDefaults?.customBadge?.position,
                discountPosition: cardDefaults?.discountBadge?.position,
                // Issue #1998 — top-corner sale badge unless the store keeps the legacy
                // bottom-left corner (per-store StoreTheme DATA, never a slug check).
                saleBadgeTopCorner: store.theme?.saleBadgeLegacyCorner !== true,
                // Issue #1997 — the carousel has no heart/compare button (so
                // topStartReserved/topEndReserved are never set here), but
                // the NEW badge / brand pill below still unconditionally
                // occupies logical top-start under this exact condition. A
                // merchant-configured top-corner badge must avoid it too.
                newOrBrandBadgeReserved:
                  showNewBadge || (inStock && store.theme?.showBrandBadge === true),
                // The carousel has no heart/compare/remove-wishlist button —
                // only the quick-add (+) circle, which is corner-only
                // (logical bottom-end), not a full-width band.
                bottomOverlay: showsQuickAddForThisProduct ? 'end' : 'none',
              });

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
                  // Item 3 (2026-07-12): first-render stagger fade, 40ms step,
                  // motion-safe only — no layout shift (opacity/transform only).
                  className={`snap-start shrink-0 w-[44vw] sm:w-[28vw] md:w-[22vw] ${lookCarouselLgWidth(cardGap)} ${sizeCap} ${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`}
                  style={
                    {
                      ['--i' as string]: i,
                      ...(showCardFrame && cardFrameColor && store.theme
                        ? { borderColor: resolveColor(cardFrameColor, store.theme) }
                        : undefined),
                    } as React.CSSProperties
                  }
                >
                  {/* Sprint 2 (2026-05-17): hover-scale 1.02 on the card
                      frame for the same micro-payoff StorefrontProductCard
                      now uses. Mobile loses nothing (no hover state).
                      cn() (tailwind-merge) resolves the shape/pack-style
                      concatenation so conflicting utilities (rounded-*,
                      duration-*, transition-*) collapse to one winner —
                      verified zero rendered-output change. */}
                  <div
                    className={cn(
                      'flex flex-col h-full overflow-hidden transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
                      cardHoverCls(store.theme),
                      dedupInnerFrame ? '' : styles.card,
                      // LAST: the merchant's cardShape radius must beat the
                      // pack's rounded-* under tailwind-merge (#665).
                      shape.radius
                    )}
                  >
                    <Link
                      href={href}
                      prefetch={false}
                      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                    >
                      <div
                        className={`group/img relative ${effectiveAspectCls} ${imgRadiusCls || shape.radius} overflow-hidden bg-muted`}
                      >
                        {/* Task 3 B4: OOS badge customization via productCardDefaults. */}
                        <OutOfStockRibbon
                          flat={onLook}
                          inStock={orderable}
                          isRtl={isRtl}
                          oosLabel={resolvedOosLabel}
                          oosLabelTextEn={resolvedOosLabelTextEn}
                          oosLabelTextAr={resolvedOosLabelTextAr}
                          oosLabelShape={resolvedOosLabelShape}
                          oosLabelPlacement={resolvedOosLabelPlacement}
                          oosLabelColor={resolvedOosLabelColor}
                          oosLabelTextColor={resolvedOosLabelTextColor}
                          theme={store.theme}
                          topStartReserved={discountTopCorner === 'start'}
                          topEndReserved={discountTopCorner === 'end'}
                        />
                        {/* Image overlay tint when out-of-stock. z-[5] sits under
                            the OOS badge (z-10) and above the product image. */}
                        <OosImageDim
                          orderable={orderable}
                          oosDimColor={resolvedOosDimColor}
                          theme={store.theme}
                        />
                        {/* Sprint 2: NEW orange pill top-START when new OR
                            <14 days old. Doesn't collide with OOS ribbon
                            because OOS hides NEW (see isProductNew gate). */}
                        {showNewBadge && (
                          <span
                            className={
                              chip
                                ? cn(LOOK_CHIP_CLS, 'top-3 start-3')
                                : 'absolute top-3 start-3 z-10 rounded-full bg-[hsl(var(--primary))] px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-[hsl(var(--primary-foreground))] shadow-[0_6px_14px_-6px_hsl(var(--primary)/0.5)]'
                            }
                            style={chip ? LOOK_CHIP_STYLE : undefined}
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
                              alt={product.images?.[0]?.alt || name}
                              fill
                              priority={i < 4}
                              sizes={CARD_CAROUSEL_SIZES}
                              // Only fade out on hover when there's a second
                              // image to crossfade IN. Without this guard,
                              // single-image products go transparent on
                              // hover and reveal the empty bg-muted box.
                              className={`object-cover transition-opacity duration-[var(--duration-slow)] ${
                                showHover && product.images?.[1]?.url
                                  ? 'group-hover/img:opacity-0'
                                  : ''
                              }`}
                              style={normalizeImages ? { objectFit: 'cover' } : undefined}
                            />
                            {showHover && product.images?.[1]?.url && (
                              <Image
                                src={product.images[1].url}
                                alt={product.images[1].alt || name}
                                fill
                                sizes={CARD_CAROUSEL_SIZES}
                                loading="lazy"
                                className="absolute inset-0 object-cover opacity-0 transition-opacity duration-[var(--duration-slow)] group-hover/img:opacity-100"
                              />
                            )}
                          </>
                        ) : (
                          <MissingImage label={name} />
                        )}
                        {/* BUG 1 fix: use helper for EGP/pct text.
                            BUG 2 fix: show when OOS too. Corner + color are
                            merchant-configurable via
                            productCardDefaults.discountBadge (default
                            bottom-left only when theme.saleBadgeLegacyCorner,
                            else top corner, physical — #1998). */}
                        {onSale && discountBadgeAllowed && discountBadgeText && (
                          <span
                            className={cn(
                              chip
                                ? cn(
                                    LOOK_CHIP_CLS,
                                    cardDefaults?.discountBadge?.color && 'text-white'
                                  )
                                : 'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide text-white shadow-[0_6px_16px_-6px_rgba(220,38,38,0.45)]',
                              discountBadgePositionCls
                            )}
                            style={
                              chip && !cardDefaults?.discountBadge?.color
                                ? LOOK_CHIP_STYLE
                                : { backgroundColor: discountBadgeColor }
                            }
                          >
                            {discountBadgeText}
                          </span>
                        )}
                        {/* Custom badge — merchant's own words
                            (Product.badgeLabel/-Ar). Same chip geometry as
                            the sale chip above; only corner + color differ. */}
                        {customBadgeText && (
                          <span
                            className={cn(
                              chip
                                ? LOOK_CHIP_CLS
                                : 'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide text-white shadow-[0_6px_16px_-6px_rgba(0,0,0,0.35)]',
                              customBadgePositionCls
                            )}
                            style={
                              chip && !cardDefaults?.customBadge?.color
                                ? LOOK_CHIP_STYLE
                                : {
                                    backgroundColor: customBadgeColor,
                                    color: customBadgeTextColor,
                                  }
                            }
                          >
                            {customBadgeText}
                          </span>
                        )}
                        {/* Bucket E3 (2026-05-17): quick-add (+) circle button
                            overlay — Bank Alkahraman pattern. Single tap = add
                            to cart, no PDP navigation. Renders only when
                            opt-in flag is set + in-stock + not a variant
                            parent + onAddToCart handler present — the exact
                            `showsQuickAddForThisProduct` expression above,
                            which the badge mutex also reads (issue #1609) so
                            a badge only lifts for a product this button will
                            actually render on. */}
                        {showsQuickAddForThisProduct && onAddToCart && (
                          <button
                            type="button"
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              onAddToCart(product.id);
                            }}
                            aria-label={isRtl ? 'إضافة للسلة' : 'Add to cart'}
                            // Touch hitbox: visual circle stays 40px; before:-inset-1.5
                            // grows the tap target to ~52px without changing rendered size.
                            className="before:absolute before:-inset-1.5 before:content-[''] absolute bottom-3 end-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_8px_20px_-6px_hsl(var(--primary)/0.5)] hover:scale-110 active:scale-95 transition-transform cursor-pointer"
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
                      {showLabel &&
                        (nameVisible || priceVisible) &&
                        (() => {
                          // Variant-aware pricing for carousel cards.
                          const carouselPricing = (() => {
                            const variants = product.variants ?? [];
                            const prices = variants
                              .map(v => v.price)
                              .filter((p): p is number => typeof p === 'number');
                            const minVariantPrice = prices.length > 0 ? Math.min(...prices) : null;
                            const hasVariants = variants.length > 0;
                            if (hasVariants && minVariantPrice !== null) {
                              const maxP = Math.max(...prices);
                              return {
                                mode: minVariantPrice === maxP ? 'single' : 'fromMin',
                                displayPrice: minVariantPrice,
                                displayCompare: null as number | null,
                              };
                            }
                            return {
                              mode: 'single',
                              displayPrice: product.price,
                              displayCompare: isOnSale(product)
                                ? product.compareAtPrice
                                : (null as number | null),
                            };
                          })();
                          return (
                            <div
                              className={`flex flex-1 flex-col ${textSizes.pad} gap-2 ${styles.productCardBody ?? ''}`}
                            >
                              {nameVisible && (
                                <p
                                  className={`[overflow-wrap:anywhere] line-clamp-2 min-h-[2.5em] ${textSizes.name} ${styles.productCardName}${nameCase === 'uppercase' ? ' uppercase' : ''}`}
                                  data-zone="productName"
                                  style={{
                                    fontFamily: productNameZone?.fontFamily,
                                    fontSize: responsiveFontSize(productNameZone?.fontSize),
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
                              )}
                              {priceVisible && (
                                <div
                                  className={`flex flex-wrap items-baseline gap-x-2 ${styles.productCardBody ? 'justify-center' : ''}`}
                                >
                                  <span
                                    className={`whitespace-nowrap ${textSizes.price} ${styles.productCardPrice}`}
                                    data-zone="productPrice"
                                    style={{
                                      fontFamily: productPriceZone?.fontFamily,
                                      fontSize: responsiveFontSize(productPriceZone?.fontSize),
                                      fontWeight: productPriceZone?.fontWeight,
                                      color: productPriceZone?.color,
                                      letterSpacing: productPriceZone?.letterSpacing,
                                      lineHeight: productPriceZone?.lineHeight,
                                      textTransform:
                                        productPriceZone?.textTransform as React.CSSProperties['textTransform'],
                                    }}
                                  >
                                    {carouselPricing.mode === 'fromMin'
                                      ? `${isRtl ? 'من ' : 'From '}`
                                      : ''}
                                    {price(carouselPricing.displayPrice)}
                                  </span>
                                  {carouselPricing.displayCompare && (
                                    <span className="whitespace-nowrap text-sm text-muted-foreground line-through">
                                      {price(carouselPricing.displayCompare)}
                                    </span>
                                  )}
                                </div>
                              )}
                              <SwatchDots
                                product={product}
                                max={5}
                                className={styles.productCardBody ? 'justify-center' : ''}
                              />
                              <FactChips
                                product={product}
                                className={styles.productCardBody ? 'mt-1 justify-center' : 'mt-1'}
                              />
                            </div>
                          );
                        })()}
                    </Link>
                    {/* Platform-level dual CTA: variant products → View link
                        to PDP, single-variant products → Add to cart. OOS
                        forces a disabled button regardless.
                        Ahmad 2026-05-17: when showQuickAdd is on, the (+)
                        overlay above IS the addable affordance — hiding
                        the bottom Add-to-cart button removes the
                        redundancy. View + Out Of Stock buttons still
                        render because the (+) doesn't cover those cases.
                        mt-auto pushes the CTA to the bottom of the flex
                        column so all carousel cards align at the same level
                        regardless of how many lines the product name wraps. */}
                    {/* CTA zone inline style applied via a shared style object
                        so all three CTA variants (View / OOS / Add to cart)
                        reflect the merchant's productCta typography override. */}
                    <div className="mt-auto">
                      {(() => {
                        // Contrast-guard the CTA color against the button's own bg so a
                        // baseline/zone color (e.g. token:foreground) can't render
                        // dark-on-dark on a filled button. See guardedCtaColor.
                        // Task 3 B3: ctaColor/ctaTextColor/oosDimColor from productCardDefaults.
                        const resolvedBg =
                          resolvedCtaColor && store.theme
                            ? resolveColor(resolvedCtaColor, store.theme)
                            : undefined;
                        const resolvedText =
                          resolvedCtaTextColor && store.theme
                            ? resolveColor(resolvedCtaTextColor, store.theme)
                            : undefined;
                        const ctaStyle: React.CSSProperties = {
                          fontFamily: productCtaZone?.fontFamily,
                          fontSize: responsiveFontSize(productCtaZone?.fontSize),
                          fontWeight: productCtaZone?.fontWeight,
                          color:
                            resolvedText ??
                            guardedCtaColor(
                              productCtaZone?.color,
                              styles.productCardCta,
                              store.theme
                            ),
                          letterSpacing: productCtaZone?.letterSpacing,
                          lineHeight: productCtaZone?.lineHeight,
                          textTransform:
                            productCtaZone?.textTransform as React.CSSProperties['textTransform'],
                          ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
                        };
                        // oosDimColor is an IMAGE overlay (OosImageDim) — not a CTA background.
                        const oosCtaStyle: React.CSSProperties = { ...ctaStyle };
                        const ctaViewLabel =
                          (isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ??
                          (isRtl ? 'عرض' : 'View');
                        const ctaOosLabel =
                          (isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ??
                          (isRtl ? 'نفدت الكمية' : 'Out Of Stock');
                        const ctaAddLabel =
                          (isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ??
                          (isRtl ? 'إضافة للسلة' : 'Add to cart');
                        if (
                          !lookCtaVisible(lookCta, {
                            hasVariants: hasVariants || viewOnly,
                            orderable,
                          })
                        )
                          return null;
                        return hasVariants || viewOnly ? (
                          <Link
                            href={href}
                            prefetch={false}
                            className={cn(
                              `block w-full text-center cursor-pointer ${ctaCls}`,
                              ctaExtraCls
                            )}
                            data-zone="productCta"
                            data-cta="button"
                            style={ctaStyle}
                          >
                            {ctaViewLabel}
                          </Link>
                        ) : !orderable ? (
                          <button
                            type="button"
                            disabled
                            className={cn(
                              `block w-full text-center opacity-60 cursor-not-allowed ${ctaCls}`,
                              ctaExtraCls
                            )}
                            data-zone="productCta"
                            style={oosCtaStyle}
                          >
                            {ctaOosLabel}
                          </button>
                        ) : (
                          !showQuickAdd &&
                          onAddToCart && (
                            <AdaptiveAddButton
                              stepperProductId={product.id}
                              onClick={() => onAddToCart(product.id)}
                              className={cn(
                                `block w-full text-center cursor-pointer ${ctaCls}`,
                                ctaExtraCls
                              )}
                              dataZone="productCta"
                              style={ctaStyle}
                              label={ctaAddLabel}
                            />
                          )
                        );
                      })()}
                    </div>
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

/**
 * Pack hand-over: Dahab renders its own product row (templates/dahab/
 * ProductCarousel); every other pack renders the shared carousel above. The
 * product page's related strip and the homepage both call this export.
 */
export function ProductCarousel(props: ProductCarouselProps) {
  return props.pack === 'dahab' ? (
    <DahabProductCarousel {...props} />
  ) : (
    <SharedProductCarousel {...props} />
  );
}
