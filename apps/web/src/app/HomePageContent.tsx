'use client';

import type { Product, Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { ShopChrome } from '../components';
import { toTemplateProduct, toTemplateCategory } from '../templates/adapters';
import { getHomepageTemplate } from '../lib/serverTemplate';
import type { TemplateId, StoreLayoutSettings } from '@force/shared';

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
  layout,
}: HomePageContentProps) {
  const { store } = useStore();
  const { language } = useLanguage();
  const { addItem } = useCart();
  const storeUrl = useStoreUrl();

  const isRtl = language === 'ar';
  const T = getHomepageTemplate(templateId);

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
    <ShopChrome>
      {/* Hero — toggleable + mode-aware. */}
      {layout.hero.enabled && sliderEligible && T.HeroSlider && (
        <T.HeroSlider
          slides={layout.hero.slides}
          autoplayMs={layout.hero.autoplayMs}
          isRtl={isRtl}
          pack={templateId}
        />
      )}
      {layout.hero.enabled && bannerEligible && T.HeroBanner && (
        <T.HeroBanner {...layout.hero.slides[0]} isRtl={isRtl} pack={templateId} />
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

      {/* Section titles. Each section settings type extends
          SectionTitleOverride, so the merchant can change the heading
          via the admin Layout page. Empty / unset falls back to the
          platform default. */}
      {(() => {
        const categoriesTitle = layout.categories.title || 'Shop by Category';
        const categoriesTitleAr = layout.categories.titleAr || 'تسوق حسب الفئة';
        const newArrivalsTitle = layout.newArrivals.title || 'New Arrivals';
        const newArrivalsTitleAr = layout.newArrivals.titleAr || 'أحدث المنتجات';
        const bestSellersTitle = layout.bestSellers.title || 'Best Sellers';
        const bestSellersTitleAr = layout.bestSellers.titleAr || 'الأكثر مبيعاً';
        const testimonialsTitle = layout.testimonials.title || 'Customer Reviews';
        const testimonialsTitleAr = layout.testimonials.titleAr || 'آراء العملاء';

        return (
          <>
            {/* Categories — grid or horizontal strip. Top padding kept
                small (pt-6/pt-8) so the section sits right under the
                hero with no awkward white gap — Ahmad 2026-05-16
                'close the white gap between it and the hero banner'.
                Bottom padding stays generous so the rhythm into "New
                Arrivals" below feels balanced.
                Sprint 1 (2026-05-17): bg-[hsl(var(--bg-page))] = first
                of the alternating section-background pair. When the
                merchant's backgroundPreset is `none`, both tokens
                resolve to the same color and the rhythm comes from
                padding alone; when a preset is picked, adjacent
                sections alternate visibly. */}
            {layout.categories.enabled && templateCategories.length > 0 && (
              <section className="bg-[hsl(var(--bg-page))] pt-6 pb-14 sm:pt-8 sm:pb-16 lg:pt-10 lg:pb-20">
                {layout.categories.layout === 'horizontal' && T.CategoryStrip ? (
                  <T.CategoryStrip
                    categories={templateCategories}
                    title={categoriesTitle}
                    titleAr={categoriesTitleAr}
                    kicker={layout.categories.kicker}
                    kickerAr={layout.categories.kickerAr}
                    subtitle={layout.categories.subtitle}
                    subtitleAr={layout.categories.subtitleAr}
                    seeAllHref={storeUrl('/products')}
                    isRtl={isRtl}
                    pack={templateId}
                    cardSize={layout.categories.cardSize}
                    cardAspect={layout.categories.cardAspect}
                    cardShape={layout.categories.cardShape}
                    cardGap={layout.categories.cardGap}
                    showLabel={layout.categories.showLabel}
                    showHover={layout.categories.showHover}
                  />
                ) : (
                  <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                    <T.CategoryGrid
                      categories={templateCategories}
                      title={categoriesTitle}
                      titleAr={categoriesTitleAr}
                      kicker={layout.categories.kicker}
                      kickerAr={layout.categories.kickerAr}
                      subtitle={layout.categories.subtitle}
                      subtitleAr={layout.categories.subtitleAr}
                      cardSize={layout.categories.cardSize}
                      cardAspect={layout.categories.cardAspect}
                      cardShape={layout.categories.cardShape}
                      cardGap={layout.categories.cardGap}
                      showLabel={layout.categories.showLabel}
                      showHover={layout.categories.showHover}
                      mobileColumns={layout.categories.mobileColumns}
                      desktopColumns={layout.categories.desktopColumns}
                      isRtl={isRtl}
                    />
                  </div>
                )}
              </section>
            )}

            {/* New Arrivals — pack ProductCarousel or ProductGrid fallback.
                Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates with
                the categories section above. */}
            {layout.newArrivals.enabled && templateNewArrivals.length > 0 && (
              <section className="bg-[hsl(var(--bg-section-alt))] py-14 sm:py-16 lg:py-20">
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    products={templateNewArrivals}
                    title={newArrivalsTitle}
                    titleAr={newArrivalsTitleAr}
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

            {/* Best Sellers carousel.
                Sprint 1: was `bg-muted/30` (a hardcoded muted tone);
                now `bg-[hsl(var(--bg-page))]` so it alternates with
                the section above. The previous muted-grey is preserved
                when the merchant picks the `coolGrey` preset and is
                the new default visual under `none`. */}
            {layout.bestSellers.enabled && templateBestSellers.length > 0 && (
              <section className="bg-[hsl(var(--bg-page))] py-14 sm:py-16 lg:py-20">
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    products={templateBestSellers}
                    title={bestSellersTitle}
                    titleAr={bestSellersTitleAr}
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

            {/* Testimonials — auto-hides when no qualifying reviews.
                Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates
                with Best Sellers above. */}
            {layout.testimonials.enabled && testimonials.length > 0 && T.TestimonialRow && (
              <section className="bg-[hsl(var(--bg-section-alt))] py-14 sm:py-16 lg:py-20">
                <T.TestimonialRow
                  testimonials={testimonials}
                  title={testimonialsTitle}
                  titleAr={testimonialsTitleAr}
                  isRtl={isRtl}
                  pack={templateId}
                />
              </section>
            )}
          </>
        );
      })()}

      {/* Featured products fallback when both carousels are disabled OR empty.
          Sprint 1: was `bg-muted/30`; now uses the section-alt token. */}
      {!layout.newArrivals.enabled &&
        !layout.bestSellers.enabled &&
        templateProducts.length > 0 && (
          <section className="bg-[hsl(var(--bg-section-alt))] py-14 sm:py-16 lg:py-24">
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
