'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
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

      {/* Categories — grid or horizontal strip. */}
      {layout.categories.enabled && templateCategories.length > 0 && (
        <section className="py-14 sm:py-16 lg:py-24">
          {layout.categories.layout === 'horizontal' && T.CategoryStrip ? (
            <T.CategoryStrip
              categories={templateCategories}
              title="Shop by Category"
              titleAr="تسوق حسب الفئة"
              seeAllHref={storeUrl('/products')}
              isRtl={isRtl}
              pack={templateId}
            />
          ) : (
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <T.CategoryGrid
                categories={templateCategories}
                title="Shop by Category"
                titleAr="تسوق حسب الفئة"
                isRtl={isRtl}
              />
            </div>
          )}
        </section>
      )}

      {/* New Arrivals carousel — uses dedicated horizontal strip when the
          pack ships ProductCarousel; falls back to the existing ProductGrid. */}
      {layout.newArrivals.enabled && templateNewArrivals.length > 0 && (
        <section className="py-14 sm:py-16 lg:py-20">
          {T.ProductCarousel ? (
            <T.ProductCarousel
              products={templateNewArrivals}
              title="New Arrivals"
              titleAr="أحدث المنتجات"
              seeAllHref={storeUrl('/products?sort=newest')}
              isRtl={isRtl}
              currency={store.currency}
              onAddToCart={handleAddToCart}
              pack={templateId}
            />
          ) : (
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <T.ProductGrid
                products={templateNewArrivals}
                title="New Arrivals"
                titleAr="أحدث المنتجات"
                isRtl={isRtl}
                currency={store.currency}
                columns={4}
                onAddToCart={handleAddToCart}
              />
            </div>
          )}
        </section>
      )}

      {/* Best Sellers carousel */}
      {layout.bestSellers.enabled && templateBestSellers.length > 0 && (
        <section className="bg-muted/30 py-14 sm:py-16 lg:py-20">
          {T.ProductCarousel ? (
            <T.ProductCarousel
              products={templateBestSellers}
              title="Best Sellers"
              titleAr="الأكثر مبيعاً"
              seeAllHref={storeUrl('/products?sort=best_seller')}
              isRtl={isRtl}
              currency={store.currency}
              onAddToCart={handleAddToCart}
              pack={templateId}
            />
          ) : (
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <T.ProductGrid
                products={templateBestSellers}
                title="Best Sellers"
                titleAr="الأكثر مبيعاً"
                isRtl={isRtl}
                currency={store.currency}
                columns={4}
                onAddToCart={handleAddToCart}
              />
            </div>
          )}
        </section>
      )}

      {/* Testimonials — auto-hides when no qualifying reviews. */}
      {layout.testimonials.enabled && testimonials.length > 0 && T.TestimonialRow && (
        <section className="py-14 sm:py-16 lg:py-20">
          <T.TestimonialRow testimonials={testimonials} isRtl={isRtl} pack={templateId} />
        </section>
      )}

      {/* Featured products fallback when both carousels are disabled OR empty */}
      {!layout.newArrivals.enabled &&
        !layout.bestSellers.enabled &&
        templateProducts.length > 0 && (
          <section className="bg-muted/30 py-14 sm:py-16 lg:py-24">
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

      <section className="force-gradient-primary py-16 sm:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight leading-tight">
              {isRtl ? 'جاهز للتسوق؟' : 'Ready to Start Shopping?'}
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-lg sm:text-xl text-primary-foreground/85 leading-relaxed">
              {isRtl
                ? 'انضم إلى آلاف العملاء الراضين واكتشف منتجاتنا المميزة'
                : 'Join thousands of satisfied customers and discover our amazing products.'}
            </p>
            <div className="mt-8 sm:mt-10">
              <Link href={storeUrl('/products')}>
                <Button
                  size="lg"
                  variant="secondary"
                  className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 shadow-lg"
                >
                  {isRtl ? 'تصفح المنتجات' : 'Browse Products'}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </ShopChrome>
  );
}
