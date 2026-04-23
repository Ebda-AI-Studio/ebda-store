'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { api, type Product, type Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { ShopChrome } from '../components';
import { toTemplateProduct, toTemplateCategory } from '../templates/adapters';

export default function HomePage() {
  const { store } = useStore();
  const { language } = useLanguage();
  const { addItem } = useCart();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const storeUrl = useStoreUrl();

  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isRtl = language === 'ar';

  useEffect(() => {
    async function fetchData() {
      try {
        const [productsRes, categoriesRes] = await Promise.all([
          api.getProducts({ featured: 'true', limit: '8' }),
          api.getCategories(),
        ]);

        if (productsRes.success && productsRes.data) {
          let products = productsRes.data.products || [];
          // If no featured products, fetch latest active products instead
          if (products.length === 0) {
            const allRes = await api.getProducts({ limit: '8' });
            if (allRes.success && allRes.data) {
              products = allRes.data.products || [];
            }
          }
          setFeaturedProducts(products);
        }
        if (categoriesRes.success && categoriesRes.data) {
          setCategories(categoriesRes.data.categories);
        }
      } catch {
        // Homepage still renders with empty state
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, []);

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

  // Hero customization (per-store, with fallbacks)
  const heroTitleEn = store.heroTitle || 'Shop the Future of E-Commerce';
  const heroTitleArVal = store.heroTitleAr || 'اكتشف مجموعتنا';
  const heroSubtitleEn =
    store.heroSubtitle || 'Premium products, fast delivery, and secure payments in Kuwait';
  const heroSubtitleArVal = store.heroSubtitleAr || 'أفضل المنتجات بأفضل الأسعار في الكويت';
  const heroCtaEn = store.heroCtaText || 'Shop Now';
  const heroCtaArVal = store.heroCtaTextAr || 'تسوق الآن';
  const heroCtaLink = store.heroCtaLink ? storeUrl(store.heroCtaLink) : storeUrl('/products');
  const heroImage = store.heroImage || undefined;

  // ShopChrome provides the template Header/Footer/AnnouncementBar. The body
  // uses the template's Hero / CategoryGrid / ProductGrid once they load.
  return (
    <ShopChrome>
      {T && !templateLoading && (
        <>
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
            <section className="py-16 lg:py-20">
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

          {isLoading ? (
            <section className="bg-muted/30 py-16 lg:py-20">
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse rounded-xl border bg-card p-4">
                      <div className="aspect-square rounded-lg bg-muted" />
                      <div className="mt-4 space-y-2">
                        <div className="h-4 w-3/4 rounded bg-muted" />
                        <div className="h-5 w-1/2 rounded bg-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : templateProducts.length > 0 ? (
            <section className="bg-muted/30 py-16 lg:py-20">
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
          ) : null}

          <section className="force-gradient-primary py-16 lg:py-20">
            <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
              <div className="mx-auto max-w-2xl">
                <h2 className="text-3xl font-bold text-white lg:text-4xl">
                  {isRtl ? 'جاهز للتسوق؟' : 'Ready to Start Shopping?'}
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-lg text-primary-foreground/80">
                  {isRtl
                    ? 'انضم إلى آلاف العملاء الراضين واكتشف منتجاتنا المميزة'
                    : 'Join thousands of satisfied customers and discover our amazing products.'}
                </p>
                <div className="mt-8">
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
        </>
      )}
    </ShopChrome>
  );
}
