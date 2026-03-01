'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@force/ui';
import { api, type Product, type Category } from '@/lib/api';
import { useStore, useStoreBranding, useStoreContact, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { Header, Footer } from '../components';
import type { TemplateProduct, TemplateCategory, NavItem } from '../templates/types';

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
  }).format(fils / 1000);
}

function toTemplateProduct(p: Product): TemplateProduct {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice ?? undefined,
    images: (p.images || []).map((img: { id?: string; url: string; alt?: string }) => ({
      id: img.id || p.id,
      url: img.url,
      alt: img.alt,
    })),
    inStock: p.inventory === undefined || p.inventory === null || p.inventory > 0,
    isFeatured: true,
  };
}

function toTemplateCategory(c: Category): TemplateCategory {
  return {
    id: c.id,
    name: c.name,
    nameAr: c.nameAr,
    slug: c.slug || c.name.toLowerCase().replace(/\s+/g, '-'),
    image: c.image,
    productCount: c.productCount,
  };
}

export default function HomePage() {
  const router = useRouter();
  const { store } = useStore();
  const branding = useStoreBranding();
  const contact = useStoreContact();
  const { language } = useLanguage();
  const { itemCount, addItem } = useCart();
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

  const handleSearch = (query: string) => {
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

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

  const navigation: NavItem[] = [
    { label: 'Products', labelAr: 'المنتجات', href: storeUrl('/products') },
    { label: 'Categories', labelAr: 'الفئات', href: storeUrl('/categories') },
    { label: 'About', labelAr: 'من نحن', href: storeUrl('/about') },
    { label: 'Contact', labelAr: 'تواصل معنا', href: storeUrl('/contact') },
  ];

  const templateProducts = featuredProducts.map(toTemplateProduct);
  const templateCategories = categories.map(toTemplateCategory);

  // If template components are loaded, use them
  if (T && !templateLoading) {
    return (
      <main className="flex min-h-screen flex-col">
        <T.Header
          branding={branding}
          navigation={navigation}
          isRtl={isRtl}
          cartItemCount={itemCount}
          isLoggedIn={false}
          onSearch={handleSearch}
        />

        {store.announcementBar?.enabled && (
          <T.AnnouncementBar
            text={store.announcementBar.text || ''}
            textAr={store.announcementBar.textAr}
            link={store.announcementBar.link}
            linkText={store.announcementBar.linkText}
            linkTextAr={store.announcementBar.linkTextAr}
            bgColor={store.announcementBar.bgColor}
            textColor={store.announcementBar.textColor}
            dismissible={store.announcementBar.dismissible}
            isRtl={isRtl}
          />
        )}

        <T.Hero
          title={isRtl ? 'اكتشف مجموعتنا' : 'Shop the Future of E-Commerce'}
          titleAr="اكتشف مجموعتنا"
          subtitle={
            isRtl
              ? 'أفضل المنتجات بأفضل الأسعار في الكويت'
              : 'Premium products, fast delivery, and secure payments in Kuwait'
          }
          subtitleAr="أفضل المنتجات بأفضل الأسعار في الكويت"
          ctaText="Shop Now"
          ctaTextAr="تسوق الآن"
          ctaLink={storeUrl('/products')}
          isRtl={isRtl}
        />

        {/* Categories */}
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

        {/* Featured Products */}
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

        {/* CTA Section */}
        <section className="force-gradient-primary py-16 lg:py-20">
          <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl">
              <h2 className="text-3xl font-bold text-white lg:text-4xl">
                {isRtl ? 'جاهز للتسوق؟' : 'Ready to Start Shopping?'}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-orange-100">
                {isRtl
                  ? 'انضم إلى آلاف العملاء الراضين واكتشف منتجاتنا المميزة'
                  : 'Join thousands of satisfied customers and discover our amazing products.'}
              </p>
              <div className="mt-8">
                <Link href={storeUrl('/products')}>
                  <Button
                    size="lg"
                    variant="secondary"
                    className="bg-white text-primary hover:bg-orange-50 shadow-lg"
                  >
                    {isRtl ? 'تصفح المنتجات' : 'Browse Products'}
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </section>

        <T.Footer
          branding={branding}
          contact={contact}
          socials={store.socialLinks || {}}
          navigation={navigation}
          isRtl={isRtl}
        />
      </main>
    );
  }

  // Fallback while template loads — use the generic Header/Footer
  return (
    <main className="flex min-h-screen flex-col">
      <Header />

      {/* Hero Section */}
      <section className="relative overflow-hidden hero-gradient hero-pattern">
        <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -left-20 bottom-0 h-72 w-72 rounded-full bg-orange-500/5 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-8 items-center">
            <div className="text-center lg:text-left animate-slide-up">
              <h1 className="text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                <span className="block">Shop the Future</span>
                <span className="mt-2 block bg-gradient-to-r from-primary via-orange-500 to-primary bg-clip-text text-transparent">
                  of E-Commerce
                </span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground lg:mx-0">
                Discover Kuwait&apos;s premier online shopping destination. Premium products, fast
                delivery, and secure payments.
              </p>
              <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:justify-center lg:justify-start">
                <Link href={storeUrl('/products')}>
                  <Button size="lg" className="w-full gap-2 shadow-lg shadow-primary/25 sm:w-auto">
                    Shop Now
                  </Button>
                </Link>
                <Link href={storeUrl('/categories')}>
                  <Button variant="outline" size="lg" className="w-full gap-2 sm:w-auto">
                    Browse Categories
                  </Button>
                </Link>
              </div>
            </div>

            <div className="relative animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <div className="relative mx-auto w-full max-w-lg">
                <div className="relative z-10 rounded-3xl bg-white p-6 shadow-2xl">
                  <div className="aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-orange-50 to-orange-100">
                    <div className="flex h-full items-center justify-center">
                      <div className="text-center">
                        <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-primary/20">
                          <svg
                            className="h-12 w-12 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                        <span className="text-lg font-medium text-muted-foreground">
                          Featured Products
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="absolute -bottom-6 -left-6 h-full w-full rounded-3xl bg-primary/10" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Categories from API */}
      {categories.length > 0 && (
        <section className="py-16 lg:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex items-end justify-between">
              <div>
                <h2 className="text-2xl font-bold text-foreground lg:text-3xl">Shop by Category</h2>
                <p className="mt-2 text-muted-foreground">Find what you&apos;re looking for</p>
              </div>
              <Link
                href={storeUrl('/categories')}
                className="hidden text-sm font-medium text-primary hover:text-primary/80 sm:block"
              >
                View all categories →
              </Link>
            </div>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {categories.slice(0, 4).map(category => (
                <Link
                  key={category.id}
                  href={storeUrl(`/products?category=${category.slug}`)}
                  className="group relative overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-lg"
                >
                  <div className="relative h-48 bg-gradient-to-br from-primary/10 to-primary/5 p-6">
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-6">
                      <h3 className="text-lg font-bold text-white">{category.name}</h3>
                      {category.productCount !== undefined && (
                        <p className="text-sm text-white/80">{category.productCount} products</p>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Featured Products from API */}
      <section className="bg-muted/30 py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold text-foreground lg:text-3xl">Featured Products</h2>
              <p className="mt-2 text-muted-foreground">Check out our latest arrivals</p>
            </div>
            <Link
              href={storeUrl('/products')}
              className="text-sm font-medium text-primary hover:text-primary/80"
            >
              View all products →
            </Link>
          </div>

          {isLoading ? (
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
          ) : featuredProducts.length > 0 ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {featuredProducts.slice(0, 8).map(product => (
                <Link
                  key={product.id}
                  href={storeUrl(`/products/${product.slug}`)}
                  className="group rounded-xl border bg-card shadow-sm transition hover:shadow-lg overflow-hidden"
                >
                  <div className="aspect-square overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100">
                    {product.images?.[0]?.url ? (
                      <img
                        src={product.images[0].url}
                        alt={product.name}
                        className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
                          <svg
                            className="h-8 w-8 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1">
                      {product.name}
                    </h3>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-lg font-bold text-primary">
                        {formatPrice(product.price)}
                      </span>
                      {product.compareAtPrice && product.compareAtPrice > product.price && (
                        <span className="text-sm text-muted-foreground line-through">
                          {formatPrice(product.compareAtPrice)}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No products available yet.</p>
              <Link href={storeUrl('/products')}>
                <Button className="mt-4">Browse All Products</Button>
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="force-gradient-primary py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-3xl font-bold text-white lg:text-4xl">Ready to Start Shopping?</h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-orange-100">
              Join thousands of satisfied customers and discover our amazing products.
            </p>
            <div className="mt-8">
              <Link href={storeUrl('/products')}>
                <Button
                  size="lg"
                  variant="secondary"
                  className="bg-white text-primary hover:bg-orange-50 shadow-lg"
                >
                  Browse Products
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
