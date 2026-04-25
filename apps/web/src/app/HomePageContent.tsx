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
import type { TemplateId } from '@force/shared';

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
interface HomePageContentProps {
  templateId: TemplateId;
  featuredProducts: Product[];
  categories: Category[];
  storeName: string;
}

export function HomePageContent({
  templateId,
  featuredProducts,
  categories,
}: HomePageContentProps) {
  const { store } = useStore();
  const { language } = useLanguage();
  const { addItem } = useCart();
  const storeUrl = useStoreUrl();

  const isRtl = language === 'ar';
  const T = getHomepageTemplate(templateId);

  const handleAddToCart = async (productId: string) => {
    const product = featuredProducts.find(p => p.id === productId);
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
  const templateCategories = categories.map(toTemplateCategory);

  // Hero customization (per-store, with fallbacks). Read from the StoreContext
  // store value — that's the single source of truth on the client.
  const heroTitleEn = store.heroTitle || 'Shop the Future of E-Commerce';
  const heroTitleArVal = store.heroTitleAr || 'اكتشف مجموعتنا';
  const heroSubtitleEn =
    store.heroSubtitle || 'Premium products, fast delivery, and secure payments in Kuwait';
  const heroSubtitleArVal = store.heroSubtitleAr || 'أفضل المنتجات بأفضل الأسعار في الكويت';
  const heroCtaEn = store.heroCtaText || 'Shop Now';
  const heroCtaArVal = store.heroCtaTextAr || 'تسوق الآن';
  const heroCtaLink = store.heroCtaLink ? storeUrl(store.heroCtaLink) : storeUrl('/products');
  const heroImage = store.heroImage || undefined;

  return (
    <ShopChrome>
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

      {templateCategories.length > 0 && (
        <section className="py-10 sm:py-12 lg:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <T.CategoryGrid
              categories={templateCategories}
              title="Shop by Category"
              titleAr="تسوق حسب الفئة"
              isRtl={isRtl}
            />
          </div>
        </section>
      )}

      {templateProducts.length > 0 && (
        <section className="bg-muted/30 py-10 sm:py-12 lg:py-20">
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

      <section className="force-gradient-primary py-12 sm:py-14 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-2xl font-bold text-white sm:text-3xl lg:text-4xl">
              {isRtl ? 'جاهز للتسوق؟' : 'Ready to Start Shopping?'}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base sm:text-lg text-primary-foreground/80">
              {isRtl
                ? 'انضم إلى آلاف العملاء الراضين واكتشف منتجاتنا المميزة'
                : 'Join thousands of satisfied customers and discover our amazing products.'}
            </p>
            <div className="mt-6 sm:mt-8">
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
