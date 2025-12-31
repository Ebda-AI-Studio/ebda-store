'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
import { Header, Footer } from '../components';

export default function HomePage() {
  const categories = [
    {
      name: 'Electronics',
      nameAr: 'إلكترونيات',
      count: 156,
      color: 'from-blue-500 to-blue-600',
      icon: '📱',
    },
    {
      name: 'Fashion',
      nameAr: 'أزياء',
      count: 342,
      color: 'from-pink-500 to-rose-600',
      icon: '👗',
    },
    {
      name: 'Home & Living',
      nameAr: 'المنزل',
      count: 89,
      color: 'from-amber-500 to-orange-600',
      icon: '🏠',
    },
    {
      name: 'Beauty',
      nameAr: 'الجمال',
      count: 124,
      color: 'from-purple-500 to-violet-600',
      icon: '💄',
    },
  ];

  const features = [
    {
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
        </svg>
      ),
      title: 'Premium Quality',
      titleAr: 'جودة عالية',
      description: 'Curated selection of premium products',
    },
    {
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
      ),
      title: 'Fast Delivery',
      titleAr: 'توصيل سريع',
      description: 'Same-day delivery across Kuwait',
    },
    {
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
      ),
      title: 'Secure Payment',
      titleAr: 'دفع آمن',
      description: 'KNET, Tap, MyFatoorah supported',
    },
    {
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      ),
      title: 'Easy Returns',
      titleAr: 'إرجاع سهل',
      description: '14-day hassle-free returns',
    },
  ];

  return (
    <main className="flex min-h-screen flex-col">
      <Header />

      {/* Hero Section */}
      <section className="relative overflow-hidden hero-gradient hero-pattern">
        {/* Decorative Elements */}
        <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -left-20 bottom-0 h-72 w-72 rounded-full bg-orange-500/5 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-8 items-center">
            {/* Text Content */}
            <div className="text-center lg:text-left animate-slide-up">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
                <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
                Powered by Force Media Kuwait
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                <span className="block">Shop the Future</span>
                <span className="mt-2 block bg-gradient-to-r from-primary via-orange-500 to-primary bg-clip-text text-transparent">
                  of E-Commerce
                </span>
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground lg:mx-0">
                Discover Kuwait&apos;s premier online shopping destination. Premium products, fast
                delivery, and secure payments with KNET and local payment providers.
              </p>
              <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:justify-center lg:justify-start">
                <Link href="/products">
                  <Button size="lg" className="w-full gap-2 shadow-lg shadow-primary/25 sm:w-auto">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                      />
                    </svg>
                    Shop Now
                  </Button>
                </Link>
                <Link href="/categories">
                  <Button variant="outline" size="lg" className="w-full gap-2 sm:w-auto">
                    Browse Categories
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </Button>
                </Link>
              </div>

              {/* Trust Badges */}
              <div className="mt-10 flex flex-wrap items-center justify-center gap-6 lg:justify-start">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <svg className="h-5 w-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Free Shipping
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <svg className="h-5 w-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Secure Checkout
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <svg className="h-5 w-5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  24/7 Support
                </div>
              </div>
            </div>

            {/* Hero Image/Visual */}
            <div className="relative animate-slide-up" style={{ animationDelay: '0.2s' }}>
              <div className="relative mx-auto w-full max-w-lg">
                {/* Main Product Card */}
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
                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <p className="font-bold text-foreground">Premium Collection</p>
                      <p className="text-sm text-muted-foreground">Starting from</p>
                    </div>
                    <p className="text-2xl font-bold text-primary">5.000 KD</p>
                  </div>
                </div>

                {/* Floating Badge */}
                <div className="absolute -right-4 -top-4 z-20 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-bold text-white shadow-lg animate-bounce-subtle">
                  New Arrivals
                </div>

                {/* Background Decoration */}
                <div className="absolute -bottom-6 -left-6 h-full w-full rounded-3xl bg-primary/10" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="border-y bg-card py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, index) => (
              <div
                key={feature.title}
                className="flex flex-col items-center text-center animate-slide-up"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  {feature.icon}
                </div>
                <h3 className="text-base font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Categories Section */}
      <section className="py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold text-foreground lg:text-3xl">Shop by Category</h2>
              <p className="mt-2 text-muted-foreground">Find what you&apos;re looking for</p>
            </div>
            <Link
              href="/categories"
              className="hidden text-sm font-medium text-primary hover:text-primary/80 sm:block"
            >
              View all categories →
            </Link>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 stagger-animation">
            {categories.map(category => (
              <Link
                key={category.name}
                href={`/products?category=${category.name.toLowerCase()}`}
                className="category-card group"
              >
                <div className={`relative h-48 bg-gradient-to-br ${category.color} p-6`}>
                  <div className="absolute right-4 top-4 text-4xl opacity-50 group-hover:opacity-100 transition-opacity">
                    {category.icon}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-6">
                    <h3 className="text-lg font-bold text-white">{category.name}</h3>
                    <p className="text-sm text-white/80">{category.count} products</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Products Section */}
      <section className="bg-muted/30 py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold text-foreground lg:text-3xl">Featured Products</h2>
              <p className="mt-2 text-muted-foreground">Check out our latest arrivals</p>
            </div>
            <Link
              href="/products"
              className="text-sm font-medium text-primary hover:text-primary/80"
            >
              View all products →
            </Link>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 stagger-animation">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="product-card group">
                {/* Product Badge */}
                {i === 1 && <span className="product-badge product-badge-new">New</span>}
                {i === 2 && <span className="product-badge product-badge-sale">-20%</span>}
                {i === 3 && (
                  <span className="product-badge product-badge-bestseller">Bestseller</span>
                )}

                {/* Product Image */}
                <div className="aspect-square overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100">
                  <div className="product-image flex h-full items-center justify-center">
                    <div className="text-center">
                      <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
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
                      <span className="text-sm text-muted-foreground">Product {i}</span>
                    </div>
                  </div>
                </div>

                {/* Product Info */}
                <div className="p-4">
                  {/* Rating */}
                  <div className="mb-2 flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map(star => (
                      <svg
                        key={star}
                        className={`rating-star ${star <= 4 ? 'rating-star-filled' : 'rating-star-empty'}`}
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    ))}
                    <span className="ml-1 text-xs text-muted-foreground">(24)</span>
                  </div>

                  <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    Premium Product {i}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-1">
                    High quality product with premium features
                  </p>

                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <span className="text-lg font-bold text-primary">
                        {(i * 5.5).toFixed(3)} KD
                      </span>
                      {i === 2 && (
                        <span className="ml-2 text-sm text-muted-foreground line-through">
                          6.875 KD
                        </span>
                      )}
                    </div>
                    <button className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-white shadow-md transition-all hover:scale-105 hover:shadow-lg">
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 4v16m8-8H4"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Newsletter / CTA Section */}
      <section className="force-gradient-primary py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-3xl font-bold text-white lg:text-4xl">Ready to Start Shopping?</h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-orange-100">
              Join thousands of satisfied customers and discover our amazing products. Subscribe to
              our newsletter for exclusive deals.
            </p>

            <form className="newsletter-form mt-8">
              <input
                type="email"
                placeholder="Enter your email address"
                className="newsletter-input"
              />
              <Button
                size="lg"
                variant="secondary"
                className="bg-white text-primary hover:bg-orange-50 shadow-lg"
              >
                Subscribe
              </Button>
            </form>

            <p className="mt-4 text-sm text-orange-200">
              By subscribing, you agree to our Privacy Policy. Unsubscribe anytime.
            </p>
          </div>
        </div>
      </section>

      {/* Why Choose Us */}
      <section className="py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-foreground lg:text-3xl">Why Shop With Us?</h2>
            <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
              We&apos;re committed to providing the best shopping experience in Kuwait
            </p>
          </div>

          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-100">
                <svg
                  className="h-8 w-8 text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-foreground">Best Prices</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Competitive prices with regular discounts and special offers
              </p>
            </div>

            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100">
                <svg
                  className="h-8 w-8 text-emerald-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-foreground">100% Authentic</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                All products are genuine and sourced from authorized distributors
              </p>
            </div>

            <div className="text-center sm:col-span-2 lg:col-span-1">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-purple-100">
                <svg
                  className="h-8 w-8 text-purple-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-foreground">24/7 Support</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Our customer service team is always here to help you
              </p>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
