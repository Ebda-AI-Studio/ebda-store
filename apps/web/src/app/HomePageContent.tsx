'use client';

import React from 'react';
import type { Product, Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { ShopChrome } from '../components';
import { BrandStoryBlock } from '../templates/shared/BrandStoryBlock';
import { TrustStrip } from '../templates/shared/TrustStrip';
import { HomeBlogCarousel } from '../templates/shared/HomeBlogCarousel';
import { SectionDivider, resolveSlotDividerSettings } from '../templates/shared/SectionDivider';
import { toTemplateProduct, toTemplateCategory } from '../templates/adapters';
import { getHomepageTemplate } from '../lib/serverTemplate';
import type { TemplateId, StoreLayoutSettings } from '@force/shared';
import { sectionBgStyle } from '../templates/shared/section-bg';
import { resolveSectionZone } from '../templates/shared/section-typography';

/**
 * Thin client wrapper for the homepage. Server-fetched products + categories
 * are passed in as props; this component only owns the cart-add handler so
 * the actual content (hero, category grid, product grid) renders server-side
 * via the directly-imported template subcomponents.
 *
 * This keeps the LCP element (hero image) on the SSR path — the previous
 * `'use client'` page.tsx blocked LCP behind JS parse → chunk fetch → API
 * round-trip.
 */
interface HomepageTestimonial {
  id: string;
  rating: number;
  title: string | null;
  comment: string;
  authorName: string;
  authorCity: string | null;
  createdAt: string;
}

interface HomePageContentProps {
  templateId: TemplateId;
  featuredProducts: Product[];
  newArrivals: Product[];
  bestSellers: Product[];
  categories: Category[];
  testimonials: HomepageTestimonial[];
  /** Additional products server-fetched for layout.extracarousels entries
   *  (category-slug and manual-ids sources). Merged into the union the
   *  storefront filters against. */
  extraProducts?: Product[];
  storeName: string;
  layout: StoreLayoutSettings;
}

export function HomePageContent({
  templateId,
  featuredProducts,
  newArrivals,
  bestSellers,
  categories,
  testimonials,
  extraProducts,
  layout,
}: HomePageContentProps) {
  const { store } = useStore();
  const { language } = useLanguage();
  const { addItem } = useCart();
  const storeUrl = useStoreUrl();

  const isRtl = language === 'ar';
  const T = getHomepageTemplate(templateId);

  // Per-section typography zones. Global zones are not accessible client-side
  // here (they're applied via CSS injection in layout.tsx), so we pass
  // undefined for the global zone — resolveSectionZone returns just the
  // section-level override values. When no per-section override is set,
  // resolveSectionZone returns undefined and SectionHeading uses its
  // default CSS class styling (no inline style applied).
  // Hero heading typography zone — wires the merchant's per-section heading
  // override to the HeroBanner / HeroSlider headline h1.
  const heroHeadingZone = resolveSectionZone(
    layout.hero.typography?.heading,
    undefined,
    store.theme
  );

  const categoriesHeadingZone = resolveSectionZone(
    layout.categories.typography?.heading,
    undefined,
    store.theme
  );
  const categoriesKickerZone = resolveSectionZone(
    layout.categories.typography?.kicker,
    undefined,
    store.theme
  );
  const categoriesSubtitleZone = resolveSectionZone(
    layout.categories.typography?.subtitle,
    undefined,
    store.theme
  );
  const categoriesSeeAllZone = resolveSectionZone(
    layout.categories.typography?.seeAll,
    undefined,
    store.theme
  );
  const categoriesLabelZone = resolveSectionZone(
    layout.categories.typography?.categoryLabel,
    undefined,
    store.theme
  );

  const newArrivalsHeadingZone = resolveSectionZone(
    layout.newArrivals.typography?.heading,
    undefined,
    store.theme
  );
  const newArrivalsKickerZone = resolveSectionZone(
    layout.newArrivals.typography?.kicker,
    undefined,
    store.theme
  );
  const newArrivalsSubtitleZone = resolveSectionZone(
    layout.newArrivals.typography?.subtitle,
    undefined,
    store.theme
  );
  const newArrivalsSeeAllZone = resolveSectionZone(
    layout.newArrivals.typography?.seeAll,
    undefined,
    store.theme
  );
  const newArrivalsProductNameZone = resolveSectionZone(
    layout.newArrivals.typography?.productName,
    undefined,
    store.theme
  );
  const newArrivalsProductPriceZone = resolveSectionZone(
    layout.newArrivals.typography?.productPrice,
    undefined,
    store.theme
  );
  const newArrivalsProductCtaZone = resolveSectionZone(
    layout.newArrivals.typography?.productCta,
    undefined,
    store.theme
  );

  const bestSellersHeadingZone = resolveSectionZone(
    layout.bestSellers.typography?.heading,
    undefined,
    store.theme
  );
  const bestSellersKickerZone = resolveSectionZone(
    layout.bestSellers.typography?.kicker,
    undefined,
    store.theme
  );
  const bestSellersSubtitleZone = resolveSectionZone(
    layout.bestSellers.typography?.subtitle,
    undefined,
    store.theme
  );
  const bestSellersSeeAllZone = resolveSectionZone(
    layout.bestSellers.typography?.seeAll,
    undefined,
    store.theme
  );
  const bestSellersProductNameZone = resolveSectionZone(
    layout.bestSellers.typography?.productName,
    undefined,
    store.theme
  );
  const bestSellersProductPriceZone = resolveSectionZone(
    layout.bestSellers.typography?.productPrice,
    undefined,
    store.theme
  );
  const bestSellersProductCtaZone = resolveSectionZone(
    layout.bestSellers.typography?.productCta,
    undefined,
    store.theme
  );

  const testimonialsHeadingZone = resolveSectionZone(
    layout.testimonials.typography?.heading,
    undefined,
    store.theme
  );
  const testimonialsKickerZone = resolveSectionZone(
    layout.testimonials.typography?.kicker,
    undefined,
    store.theme
  );
  const testimonialsSubtitleZone = resolveSectionZone(
    layout.testimonials.typography?.subtitle,
    undefined,
    store.theme
  );

  // Build a single lookup so the cart-add handler works for products from any
  // of the three sources (featured, new arrivals, best sellers).
  const allProducts = [...featuredProducts, ...newArrivals, ...bestSellers];
  const productById = new Map(allProducts.map(p => [p.id, p]));

  const handleAddToCart = async (productId: string) => {
    const product = productById.get(productId);
    if (!product) return;
    addItem(
      {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr ?? undefined,
        price: product.price,
        slug: product.slug,
        image: product.images?.[0]?.url,
      },
      1
    );
  };

  const templateProducts = featuredProducts.map(toTemplateProduct);
  const templateNewArrivals = newArrivals.map(toTemplateProduct);
  const templateBestSellers = bestSellers.map(toTemplateProduct);
  const templateCategories = categories.map(toTemplateCategory);

  // Hero customization. Read from the StoreContext store — single source of
  // truth on the client. The fallback for an empty headline is the store's
  // own name (per locale), not a marketing demo string. Subtitle stays empty
  // when the merchant hasn't written one — better to show nothing than a
  // generic "Premium products, fast delivery..." strapline that's not true
  // for every tenant. CTA text + link have safe generic defaults because
  // they're functional UI, not content.
  const heroTitleEn = store.heroTitle || store.name || '';
  const heroTitleArVal = store.heroTitleAr || store.nameAr || store.name || '';
  const heroSubtitleEn = store.heroSubtitle || '';
  const heroSubtitleArVal = store.heroSubtitleAr || '';
  const heroCtaEn = store.heroCtaText || 'Shop Now';
  const heroCtaArVal = store.heroCtaTextAr || 'تسوق الآن';
  const heroCtaLink = store.heroCtaLink ? storeUrl(store.heroCtaLink) : storeUrl('/products');
  const heroImage = store.heroImage || undefined;

  // Hero rendering: prefer the new HeroSlider/HeroBanner shells when the
  // store has supplied slides via layout.hero. When no slides exist we fall
  // back to the legacy T.Hero (which uses the per-store hero text fields).
  const sliderEligible =
    layout.hero.mode === 'slider' && layout.hero.slides.length > 0 && !!T.HeroSlider;
  const bannerEligible =
    layout.hero.mode === 'single' && layout.hero.slides.length > 0 && !!T.HeroBanner;
  // The legacy T.Hero is only useful when the merchant has supplied at
  // least one piece of content for it (title, subtitle, or image). With
  // all three empty we'd render a hero with nothing in it, which is
  // worse than just skipping the section.
  const legacyHeroHasContent = !!(
    heroTitleEn ||
    heroTitleArVal ||
    heroSubtitleEn ||
    heroSubtitleArVal ||
    heroImage
  );

  return (
    <ShopChrome layout={layout}>
      {/* Section titles. Each section settings type extends
          SectionTitleOverride, so the merchant can change the heading
          via the admin Layout page. Empty / unset falls back to the
          platform default.
          Hero is now included in this IIFE so all 8 sections can be
          ordered dynamically via layout.sectionOrder. */}
      {(() => {
        // ── Section ordering ──────────────────────────────────────────────
        type SectionKey =
          | 'hero'
          | 'categories'
          | 'newArrivals'
          | 'bestSellers'
          | 'brandStory'
          | 'blogCarousel'
          | 'trustStrip'
          | 'testimonials';

        const ALL_SECTION_KEYS: SectionKey[] = [
          'hero',
          'categories',
          'newArrivals',
          'bestSellers',
          'brandStory',
          'blogCarousel',
          'trustStrip',
          'testimonials',
        ];

        // Resolve active order: saved order (with unknown keys filtered out)
        // followed by any keys not yet in the saved list (forward-compat).
        const resolved: SectionKey[] = (() => {
          const saved = layout.sectionOrder;
          if (!saved || saved.length === 0) return ALL_SECTION_KEYS;
          const seen = new Set(
            saved.filter((k): k is SectionKey => ALL_SECTION_KEYS.includes(k as SectionKey))
          );
          const tail = ALL_SECTION_KEYS.filter(k => !seen.has(k));
          return [...Array.from(seen), ...tail];
        })();

        // ── Section title locals ──────────────────────────────────────────
        const categoriesTitle = layout.categories.title || 'Shop by Category';
        const categoriesTitleAr = layout.categories.titleAr || 'تسوق حسب الفئة';
        const newArrivalsTitle = layout.newArrivals.title || 'New Arrivals';
        const newArrivalsTitleAr = layout.newArrivals.titleAr || 'أحدث المنتجات';
        const bestSellersTitle = layout.bestSellers.title || 'Best Sellers';
        const bestSellersTitleAr = layout.bestSellers.titleAr || 'الأكثر مبيعاً';
        const testimonialsTitle = layout.testimonials.title || 'Customer Reviews';
        const testimonialsTitleAr = layout.testimonials.titleAr || 'آراء العملاء';

        // ── Per-section JSX nodes ─────────────────────────────────────────

        // Hero — toggleable + mode-aware. bgColor overrides the theme bg when set.
        const heroJSX = (
          <div data-section="hero" style={sectionBgStyle(layout.hero.bgColor, store.theme)}>
            {layout.hero.enabled && sliderEligible && T.HeroSlider && (
              <T.HeroSlider
                slides={layout.hero.slides}
                autoplayMs={layout.hero.autoplayMs}
                isRtl={isRtl}
                pack={templateId}
                presentation={layout.hero.presentation}
                headingZone={heroHeadingZone}
              />
            )}
            {layout.hero.enabled && bannerEligible && T.HeroBanner && (
              <T.HeroBanner
                {...layout.hero.slides[0]}
                isRtl={isRtl}
                pack={templateId}
                presentation={layout.hero.presentation}
                headingZone={heroHeadingZone}
              />
            )}
            {layout.hero.enabled && !sliderEligible && !bannerEligible && legacyHeroHasContent && (
              <T.Hero
                title={heroTitleEn}
                titleAr={heroTitleArVal}
                subtitle={heroSubtitleEn}
                subtitleAr={heroSubtitleArVal}
                image={heroImage}
                ctaText={heroCtaEn}
                ctaTextAr={heroCtaArVal}
                ctaLink={heroCtaLink}
                isRtl={isRtl}
              />
            )}
          </div>
        );

        // Categories — grid or horizontal strip. Top padding kept
        // small (pt-6/pt-8) so the section sits right under the
        // hero with no awkward white gap — Ahmad 2026-05-16
        // 'close the white gap between it and the hero banner'.
        // Bottom padding stays generous so the rhythm into "New
        // Arrivals" below feels balanced.
        // Sprint 1 (2026-05-17): bg-[hsl(var(--bg-page))] = first
        // of the alternating section-background pair. When the
        // merchant's backgroundPreset is `none`, both tokens
        // resolve to the same color and the rhythm comes from
        // padding alone; when a preset is picked, adjacent
        // sections alternate visibly.
        const categoriesJSX = (
          <>
            {/* Per-section `above` divider (opt-in) — renders before categories. */}
            {layout.categories.dividers?.above?.enabled && (
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.categories.dividers, 'above')}
              />
            )}
            {layout.categories.enabled && templateCategories.length > 0 && (
              <section
                data-section="categories"
                className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
                style={sectionBgStyle(layout.categories.bgColor, store.theme)}
              >
                {(() => {
                  // Desktop + mobile layout are INDEPENDENT (Ahmad 2026-06-04):
                  // `layout` is the desktop choice, `layoutMobile` the mobile one
                  // (falls back to desktop when unset). When both resolve to the
                  // same kind we render ONE component (zero change for existing
                  // stores); when they differ we render both and toggle with
                  // md: visibility so e.g. mobile=grid + desktop=horizontal works.
                  // md (768px) is the platform mobile/desktop boundary.
                  const common = {
                    categories: templateCategories,
                    title: categoriesTitle,
                    titleAr: categoriesTitleAr,
                    kicker: layout.categories.kicker,
                    kickerAr: layout.categories.kickerAr,
                    subtitle: layout.categories.subtitle,
                    subtitleAr: layout.categories.subtitleAr,
                    showKickerLines: layout.categories.showKickerLines,
                    showSubtitleLines: layout.categories.showSubtitleLines,
                    dividers: layout.categories.dividers,
                    seeAllHref: storeUrl('/products'),
                    isRtl,
                    cardSize: layout.categories.cardSize,
                    cardAspect: layout.categories.cardAspect,
                    cardShape: layout.categories.cardShape,
                    cardGap: layout.categories.cardGap,
                    showLabel: layout.categories.showLabel,
                    showHover: layout.categories.showHover,
                    showCardFrame: layout.categories.showCardFrame,
                    cardFrameStyle: layout.categories.cardFrameStyle,
                    cardFrameWidth: layout.categories.cardFrameWidth,
                    cardFrameSize: layout.categories.cardFrameSize,
                    cardFrameColor: layout.categories.cardFrameColor,
                    headingZone: categoriesHeadingZone,
                    kickerZone: categoriesKickerZone,
                    subtitleZone: categoriesSubtitleZone,
                    seeAllZone: categoriesSeeAllZone,
                    categoryLabelZone: categoriesLabelZone,
                    sectionBgColor: layout.categories.bgColor,
                  };
                  type Caption = typeof layout.categories.captionPosition;
                  const renderGrid = (caption: Caption, vis?: string) => (
                    <div className={`mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 ${vis ?? ''}`}>
                      <T.CategoryGrid
                        {...common}
                        captionPosition={caption}
                        mobileColumns={layout.categories.mobileColumns}
                        desktopColumns={layout.categories.desktopColumns}
                      />
                    </div>
                  );
                  const renderStrip = (caption: Caption, vis?: string) =>
                    T.CategoryStrip ? (
                      <div className={vis}>
                        <T.CategoryStrip {...common} captionPosition={caption} pack={templateId} />
                      </div>
                    ) : (
                      renderGrid(caption, vis)
                    );
                  const kindFor = (lay: typeof layout.categories.layout) =>
                    lay === 'horizontal' && T.CategoryStrip ? 'strip' : 'grid';
                  const desktopKind = kindFor(layout.categories.layout);
                  const mobileKind = kindFor(
                    layout.categories.layoutMobile ?? layout.categories.layout
                  );
                  const desktopCaption = layout.categories.captionPosition;
                  const mobileCaption =
                    layout.categories.captionPositionMobile ?? layout.categories.captionPosition;
                  const renderKind = (kind: 'strip' | 'grid', caption: Caption, vis?: string) =>
                    kind === 'strip' ? renderStrip(caption, vis) : renderGrid(caption, vis);
                  // Render once when desktop + mobile resolve to the SAME layout AND
                  // caption; otherwise render both trees + toggle with md: so each
                  // breakpoint gets its own layout + caption independently.
                  if (desktopKind === mobileKind && desktopCaption === mobileCaption)
                    return renderKind(desktopKind, desktopCaption);
                  return (
                    <>
                      {renderKind(mobileKind, mobileCaption, 'md:hidden')}
                      {renderKind(desktopKind, desktopCaption, 'hidden md:block')}
                    </>
                  );
                })()}
              </section>
            )}
          </>
        );

        // New Arrivals — pack ProductCarousel or ProductGrid fallback.
        // Divider between categories and new-arrivals. Suppressed when
        // either flanking section has an explicit per-section bgColor —
        // the color shift already acts as the visual separator. Per-section
        // `newArrivals.dividers.above` wins over the legacy theme.dividers
        // fallback when set.
        // Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates with
        // the categories section above.
        const newArrivalsJSX = (
          <>
            <SectionDivider
              settings={resolveSlotDividerSettings(layout.newArrivals.dividers, 'above')}
              hideForExplicitBg={!!(layout.categories.bgColor || layout.newArrivals.bgColor)}
            />
            {layout.newArrivals.enabled && templateNewArrivals.length > 0 && (
              <section
                data-section="newArrivals"
                className="bg-[hsl(var(--bg-section-alt))] py-12 sm:py-16 lg:py-20"
                style={sectionBgStyle(layout.newArrivals.bgColor, store.theme)}
              >
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    products={templateNewArrivals}
                    title={newArrivalsTitle}
                    titleAr={newArrivalsTitleAr}
                    kicker={layout.newArrivals.kicker}
                    kickerAr={layout.newArrivals.kickerAr}
                    subtitle={layout.newArrivals.subtitle}
                    subtitleAr={layout.newArrivals.subtitleAr}
                    showKickerLines={layout.newArrivals.showKickerLines}
                    showSubtitleLines={layout.newArrivals.showSubtitleLines}
                    dividers={layout.newArrivals.dividers}
                    seeAllHref={storeUrl('/products?sort=newest')}
                    isRtl={isRtl}
                    currency={store.currency}
                    onAddToCart={handleAddToCart}
                    pack={templateId}
                    cardSize={layout.newArrivals.cardSize}
                    cardAspect={layout.newArrivals.cardAspect}
                    cardShape={layout.newArrivals.cardShape}
                    cardGap={layout.newArrivals.cardGap}
                    showLabel={layout.newArrivals.showLabel}
                    showHover={layout.newArrivals.showHover}
                    showCardFrame={layout.newArrivals.showCardFrame}
                    cardFrameStyle={layout.newArrivals.cardFrameStyle}
                    cardFrameWidth={
                      layout.newArrivals.cardFrameWidth ||
                      layout.productCardDefaults?.cardFrameWidth
                    }
                    cardFrameSize={
                      layout.newArrivals.cardFrameSize || layout.productCardDefaults?.cardFrameSize
                    }
                    cardFrameColor={
                      layout.newArrivals.cardFrameColor ||
                      layout.productCardDefaults?.cardFrameColor
                    }
                    headingZone={newArrivalsHeadingZone}
                    kickerZone={newArrivalsKickerZone}
                    subtitleZone={newArrivalsSubtitleZone}
                    seeAllZone={newArrivalsSeeAllZone}
                    productNameZone={newArrivalsProductNameZone}
                    productPriceZone={newArrivalsProductPriceZone}
                    productCtaZone={newArrivalsProductCtaZone}
                    sectionBgColor={layout.newArrivals.bgColor}
                  />
                ) : (
                  <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                    <T.ProductGrid
                      products={templateNewArrivals}
                      title={newArrivalsTitle}
                      titleAr={newArrivalsTitleAr}
                      isRtl={isRtl}
                      currency={store.currency}
                      columns={4}
                      onAddToCart={handleAddToCart}
                    />
                  </div>
                )}
              </section>
            )}
          </>
        );

        // Best Sellers carousel.
        // Divider between new-arrivals and best-sellers. Per-section
        // `bestSellers.dividers.above` wins over the legacy theme.dividers
        // fallback when set.
        // Sprint 1: was `bg-muted/30` (a hardcoded muted tone);
        // now `bg-[hsl(var(--bg-page))]` so it alternates with
        // the section above. The previous muted-grey is preserved
        // when the merchant picks the `coolGrey` preset and is
        // the new default visual under `none`.
        const bestSellersJSX = (
          <>
            <SectionDivider
              settings={resolveSlotDividerSettings(layout.bestSellers.dividers, 'above')}
              hideForExplicitBg={!!(layout.newArrivals.bgColor || layout.bestSellers.bgColor)}
            />
            {layout.bestSellers.enabled && templateBestSellers.length > 0 && (
              <section
                data-section="bestSellers"
                className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
                style={sectionBgStyle(layout.bestSellers.bgColor, store.theme)}
              >
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    products={templateBestSellers}
                    title={bestSellersTitle}
                    titleAr={bestSellersTitleAr}
                    kicker={layout.bestSellers.kicker}
                    kickerAr={layout.bestSellers.kickerAr}
                    subtitle={layout.bestSellers.subtitle}
                    subtitleAr={layout.bestSellers.subtitleAr}
                    showKickerLines={layout.bestSellers.showKickerLines}
                    showSubtitleLines={layout.bestSellers.showSubtitleLines}
                    dividers={layout.bestSellers.dividers}
                    seeAllHref={storeUrl('/products?sort=best_seller')}
                    isRtl={isRtl}
                    currency={store.currency}
                    onAddToCart={handleAddToCart}
                    pack={templateId}
                    cardSize={layout.bestSellers.cardSize}
                    cardAspect={layout.bestSellers.cardAspect}
                    cardShape={layout.bestSellers.cardShape}
                    cardGap={layout.bestSellers.cardGap}
                    showLabel={layout.bestSellers.showLabel}
                    showHover={layout.bestSellers.showHover}
                    showCardFrame={layout.bestSellers.showCardFrame}
                    cardFrameStyle={layout.bestSellers.cardFrameStyle}
                    cardFrameWidth={
                      layout.bestSellers.cardFrameWidth ||
                      layout.productCardDefaults?.cardFrameWidth
                    }
                    cardFrameSize={
                      layout.bestSellers.cardFrameSize || layout.productCardDefaults?.cardFrameSize
                    }
                    cardFrameColor={
                      layout.bestSellers.cardFrameColor ||
                      layout.productCardDefaults?.cardFrameColor
                    }
                    headingZone={bestSellersHeadingZone}
                    kickerZone={bestSellersKickerZone}
                    subtitleZone={bestSellersSubtitleZone}
                    seeAllZone={bestSellersSeeAllZone}
                    productNameZone={bestSellersProductNameZone}
                    productPriceZone={bestSellersProductPriceZone}
                    productCtaZone={bestSellersProductCtaZone}
                    sectionBgColor={layout.bestSellers.bgColor}
                  />
                ) : (
                  <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                    <T.ProductGrid
                      products={templateBestSellers}
                      title={bestSellersTitle}
                      titleAr={bestSellersTitleAr}
                      isRtl={isRtl}
                      currency={store.currency}
                      columns={4}
                      onAddToCart={handleAddToCart}
                    />
                  </div>
                )}
              </section>
            )}
          </>
        );

        // Sprint 3 + Bucket E (2026-05-17): brand story band.
        // Brand story uses store.heroImage + store.description
        // as platform defaults — null-safe via internal guard.
        // Brand Story — folded into page-builder 2026-05-20.
        // Legacy fallback: `theme.showBrandStory`.
        const brandStoryJSX =
          (layout.brandStory?.enabled ?? store.theme?.showBrandStory !== false) ? (
            <>
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.brandStory?.dividers, 'above')}
                hideForExplicitBg={!!(layout.bestSellers.bgColor || layout.brandStory?.bgColor)}
              />
              <BrandStoryBlock
                image={store.heroImage ?? undefined}
                body={store.description ?? undefined}
                bodyAr={store.descriptionAr ?? undefined}
              />
            </>
          ) : null;

        // Blog Carousel — folded into page-builder 2026-05-20.
        // Legacy fallback: `store.blogEnabled`.
        const blogCarouselJSX =
          (layout.blogCarousel?.enabled ?? store.blogEnabled !== false) ? (
            <>
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.blogCarousel?.dividers, 'above')}
                hideForExplicitBg={!!layout.blogCarousel?.bgColor}
              />
              <HomeBlogCarousel />
            </>
          ) : null;

        // Trust Strip — folded into page-builder 2026-05-20.
        // Ships 3 universal items (Fast Delivery / Quality / Support)
        // with bilingual platform copy. Auto-hides when disabled.
        // Legacy fallback: `theme.showTrustStrip`.
        const trustStripJSX =
          (layout.trustStrip?.enabled ?? store.theme?.showTrustStrip !== false) ? (
            <>
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.trustStrip?.dividers, 'above')}
                hideForExplicitBg={!!layout.trustStrip?.bgColor}
              />
              <TrustStrip settings={layout.trustStrip} />
            </>
          ) : null;

        // Testimonials — auto-hides when no qualifying reviews.
        // Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates
        // with Best Sellers above. Divider before testimonials.
        // Suppressed when testimonials section has an explicit
        // per-section bgColor. Per-section `testimonials.dividers.above`
        // wins over the legacy fallback.
        const testimonialsJSX = (
          <>
            <SectionDivider
              settings={resolveSlotDividerSettings(layout.testimonials.dividers, 'above')}
              hideForExplicitBg={!!layout.testimonials.bgColor}
            />
            {layout.testimonials.enabled && testimonials.length > 0 && T.TestimonialRow && (
              <section
                data-section="testimonials"
                className="bg-[hsl(var(--bg-section-alt))] py-12 sm:py-16 lg:py-20"
                style={sectionBgStyle(layout.testimonials.bgColor, store.theme)}
              >
                <T.TestimonialRow
                  testimonials={testimonials}
                  title={testimonialsTitle}
                  titleAr={testimonialsTitleAr}
                  isRtl={isRtl}
                  pack={templateId}
                  headingZone={testimonialsHeadingZone}
                  kickerZone={testimonialsKickerZone}
                  subtitleZone={testimonialsSubtitleZone}
                  dividers={layout.testimonials.dividers}
                  sectionBgColor={layout.testimonials.bgColor}
                />
              </section>
            )}
          </>
        );

        // ── Section map + ordered render ──────────────────────────────────
        const sectionMap: Record<SectionKey, React.ReactNode> = {
          hero: heroJSX,
          categories: categoriesJSX,
          newArrivals: newArrivalsJSX,
          bestSellers: bestSellersJSX,
          brandStory: brandStoryJSX,
          blogCarousel: blogCarouselJSX,
          trustStrip: trustStripJSX,
          testimonials: testimonialsJSX,
        };

        // Extra duplicated carousels (section duplication 2026-05-20). Each
        // entry is a ProductCarousel with its own product source. v1 renders
        // them in array order AFTER the static section loop; v2 will integrate
        // with sectionOrder via 'extra:<id>' keys.
        const extras = layout.extraCarousels ?? [];
        // Union of all server-fetched RAW products (not template adapters) so
        // 'category' filter can read raw.categories[].slug. Includes
        // extraProducts which were fetched specifically for layout.extracarousels
        // entries that use 'category' or 'manual' productSource — without this
        // merge the storefront would only see products already in newArrivals/
        // bestSellers/featured and miss any merchant-configured category that
        // doesn't overlap with those lists.
        const allRawProducts = (() => {
          const map = new Map<string, Product>();
          for (const p of [
            ...newArrivals,
            ...bestSellers,
            ...featuredProducts,
            ...(extraProducts ?? []),
          ]) {
            map.set(p.id, p);
          }
          return Array.from(map.values());
        })();
        const extraJSX = extras.map(extra => {
          if (extra.enabled === false) return null;
          let sourceProducts: typeof templateNewArrivals;
          if (extra.productSource === 'best_seller') {
            sourceProducts = templateBestSellers;
          } else if (extra.productSource === 'featured') {
            sourceProducts = templateProducts;
          } else if (extra.productSource === 'category' && extra.categorySlug) {
            const slug = extra.categorySlug.toLowerCase();
            const matched = allRawProducts.filter(p =>
              (p.categories ?? []).some(c => (c?.category?.slug ?? '').toLowerCase() === slug)
            );
            sourceProducts = matched.map(toTemplateProduct);
            // Empty match → fall back to newest so the carousel never renders
            // as a confusing 0-product block once a merchant configures it.
            if (sourceProducts.length === 0) sourceProducts = templateNewArrivals;
          } else if (extra.productSource === 'manual' && extra.manualProductIds?.length) {
            const productMap = new Map(allRawProducts.map(p => [p.id, p]));
            const matched = extra.manualProductIds
              .map(id => productMap.get(id))
              .filter((p): p is Product => !!p);
            sourceProducts = matched.map(toTemplateProduct);
            if (sourceProducts.length === 0) sourceProducts = templateNewArrivals;
          } else {
            sourceProducts = templateNewArrivals;
          }
          const capped = sourceProducts.slice(0, extra.limit ?? 12);
          if (capped.length === 0) return null;
          if (!T.ProductCarousel) return null;
          return (
            <React.Fragment key={`extra:${extra.id}`}>
              {extra.dividers?.above?.enabled && (
                <SectionDivider settings={resolveSlotDividerSettings(extra.dividers, 'above')} />
              )}
              <section
                data-section={`extra:${extra.id}`}
                className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
                style={sectionBgStyle(extra.bgColor, store.theme)}
              >
                <T.ProductCarousel
                  products={capped}
                  title={extra.title}
                  titleAr={extra.titleAr}
                  kicker={extra.kicker}
                  kickerAr={extra.kickerAr}
                  subtitle={extra.subtitle}
                  subtitleAr={extra.subtitleAr}
                  showKickerLines={extra.showKickerLines}
                  showSubtitleLines={extra.showSubtitleLines}
                  dividers={extra.dividers}
                  isRtl={isRtl}
                  currency={store.currency}
                  onAddToCart={handleAddToCart}
                  pack={templateId}
                  cardSize={extra.cardSize}
                  cardAspect={extra.cardAspect}
                  cardShape={extra.cardShape}
                  cardGap={extra.cardGap}
                  showLabel={extra.showLabel}
                  showHover={extra.showHover}
                  showCardFrame={extra.showCardFrame}
                  cardFrameStyle={extra.cardFrameStyle}
                  cardFrameWidth={extra.cardFrameWidth}
                  cardFrameSize={extra.cardFrameSize}
                  cardFrameColor={extra.cardFrameColor}
                  sectionBgColor={extra.bgColor}
                />
              </section>
            </React.Fragment>
          );
        });

        return (
          <>
            {resolved.map(key => (
              <React.Fragment key={key}>{sectionMap[key]}</React.Fragment>
            ))}
            {extraJSX}
          </>
        );
      })()}

      {/* Featured products fallback when both carousels are disabled OR empty.
          Sprint 1: was `bg-muted/30`; now uses the section-alt token. */}
      {!layout.newArrivals.enabled &&
        !layout.bestSellers.enabled &&
        templateProducts.length > 0 && (
          <section className="bg-[hsl(var(--bg-section-alt))] py-12 sm:py-16 lg:py-20">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <T.ProductGrid
                products={templateProducts}
                title="Featured Products"
                titleAr="منتجات مميزة"
                isRtl={isRtl}
                currency={store.currency}
                columns={4}
                onAddToCart={handleAddToCart}
              />
            </div>
          </section>
        )}

      {/* "Ready to Start Shopping? / Join thousands of satisfied customers"
          banner removed — was hardcoded marketing copy that competed with
          merchant content. Stores that want a closing CTA can use the
          AnnouncementBar or surface it through their hero / categories. */}
    </ShopChrome>
  );
}
