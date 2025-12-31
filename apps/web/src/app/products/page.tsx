'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';

// Demo products data with KWD prices
const products = [
  {
    id: '1',
    name: 'Premium Wireless Headphones',
    slug: 'premium-wireless-headphones',
    price: 29.9,
    compareAtPrice: 34.9,
    category: 'Electronics',
    rating: 4.8,
    reviews: 124,
    badge: 'Sale',
  },
  {
    id: '2',
    name: 'Smart Watch Pro',
    slug: 'smart-watch-pro',
    price: 39.9,
    compareAtPrice: 44.9,
    category: 'Wearables',
    rating: 4.9,
    reviews: 89,
    badge: 'New',
  },
  {
    id: '3',
    name: 'USB-C Hub 7-in-1',
    slug: 'usb-c-hub-7-in-1',
    price: 7.9,
    category: 'Accessories',
    rating: 4.5,
    reviews: 56,
  },
  {
    id: '4',
    name: 'Wireless Mechanical Keyboard',
    slug: 'wireless-mechanical-keyboard',
    price: 14.9,
    compareAtPrice: 17.9,
    category: 'Accessories',
    rating: 4.7,
    reviews: 203,
    badge: 'Bestseller',
  },
  {
    id: '5',
    name: 'Portable Bluetooth Speaker',
    slug: 'portable-bluetooth-speaker',
    price: 12.9,
    category: 'Electronics',
    rating: 4.6,
    reviews: 78,
  },
  {
    id: '6',
    name: 'Fitness Tracker Band',
    slug: 'fitness-tracker-band',
    price: 9.9,
    compareAtPrice: 12.9,
    category: 'Wearables',
    rating: 4.4,
    reviews: 145,
    badge: 'Sale',
  },
  {
    id: '7',
    name: '4K Webcam Pro',
    slug: '4k-webcam-pro',
    price: 19.9,
    category: 'Electronics',
    rating: 4.8,
    reviews: 67,
  },
  {
    id: '8',
    name: 'Ergonomic Mouse',
    slug: 'ergonomic-mouse',
    price: 8.9,
    category: 'Accessories',
    rating: 4.3,
    reviews: 92,
  },
  {
    id: '9',
    name: 'Noise Cancelling Earbuds',
    slug: 'noise-cancelling-earbuds',
    price: 24.9,
    compareAtPrice: 29.9,
    category: 'Electronics',
    rating: 4.7,
    reviews: 156,
    badge: 'Sale',
  },
  {
    id: '10',
    name: 'Smart Home Hub',
    slug: 'smart-home-hub',
    price: 35.5,
    category: 'Electronics',
    rating: 4.5,
    reviews: 43,
    badge: 'New',
  },
  {
    id: '11',
    name: 'Leather Watch Band',
    slug: 'leather-watch-band',
    price: 6.5,
    category: 'Accessories',
    rating: 4.6,
    reviews: 87,
  },
  {
    id: '12',
    name: 'Smart Scale Pro',
    slug: 'smart-scale-pro',
    price: 15.9,
    category: 'Wearables',
    rating: 4.4,
    reviews: 112,
  },
];

const categories = [
  { name: 'All', count: products.length },
  { name: 'Electronics', count: products.filter(p => p.category === 'Electronics').length },
  { name: 'Accessories', count: products.filter(p => p.category === 'Accessories').length },
  { name: 'Wearables', count: products.filter(p => p.category === 'Wearables').length },
];

const sortOptions = [
  { value: 'featured', label: 'Featured' },
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'rating', label: 'Top Rated' },
];

function formatPrice(kwd: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(kwd);
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(star => (
        <svg
          key={star}
          className={`h-3.5 w-3.5 ${star <= rating ? 'text-amber-400' : 'text-gray-200'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  );
}

export default function ProductsPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [sortBy, setSortBy] = useState('featured');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const filteredProducts = products
    .filter(product => {
      const matchesSearch = product.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = category === 'All' || product.category === category;
      return matchesSearch && matchesCategory;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'price-asc':
          return a.price - b.price;
        case 'price-desc':
          return b.price - a.price;
        case 'rating':
          return b.rating - a.rating;
        case 'newest':
          return parseInt(b.id) - parseInt(a.id);
        default:
          return 0;
      }
    });

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/" className="transition-colors hover:text-primary">
            Home
          </Link>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-foreground">Products</span>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            All Products
          </h1>
          <p className="mt-2 text-muted-foreground">Browse our collection of premium products</p>
        </div>

        <div className="flex flex-col gap-8 lg:flex-row">
          {/* Sidebar Filters */}
          <aside className="w-full shrink-0 lg:w-64">
            <div className="sticky top-24 space-y-6">
              {/* Search */}
              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">Search</label>
                <div className="search-box">
                  <svg
                    className="h-5 w-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="search-input"
                  />
                </div>
              </div>

              {/* Categories */}
              <div>
                <h3 className="mb-3 text-sm font-medium text-foreground">Categories</h3>
                <div className="space-y-2">
                  {categories.map(cat => (
                    <button
                      key={cat.name}
                      onClick={() => setCategory(cat.name)}
                      className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm transition-all ${
                        category === cat.name
                          ? 'bg-primary text-white shadow-md shadow-primary/25'
                          : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span>{cat.name}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          category === cat.name ? 'bg-white/20' : 'bg-background'
                        }`}
                      >
                        {cat.count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Price Range */}
              <div>
                <h3 className="mb-3 text-sm font-medium text-foreground">Price Range</h3>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder="Min"
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      type="number"
                      placeholder="Max"
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {['Under 10 KWD', '10-25 KWD', '25-50 KWD', 'Over 50 KWD'].map(range => (
                      <button
                        key={range}
                        className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                      >
                        {range}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Clear Filters */}
              <button
                onClick={() => {
                  setSearch('');
                  setCategory('All');
                }}
                className="w-full rounded-xl border border-border py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
              >
                Clear All Filters
              </button>
            </div>
          </aside>

          {/* Products Grid */}
          <div className="flex-1">
            {/* Toolbar */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">
                Showing{' '}
                <span className="font-medium text-foreground">{filteredProducts.length}</span>{' '}
                products
              </p>
              <div className="flex items-center gap-4">
                {/* Sort */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Sort by:</span>
                  <select
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value)}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    {sortOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* View Mode */}
                <div className="hidden items-center gap-1 rounded-lg border border-border bg-background p-1 sm:flex">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`rounded-md p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`rounded-md p-1.5 transition-colors ${viewMode === 'list' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 10h16M4 14h16M4 18h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Grid View */}
            {viewMode === 'grid' && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {filteredProducts.map((product, index) => (
                  <Link
                    key={product.id}
                    href={`/products/${product.slug}`}
                    className="product-card group"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    {/* Badge */}
                    {product.badge && (
                      <span
                        className={`product-badge ${
                          product.badge === 'Sale'
                            ? 'bg-red-500'
                            : product.badge === 'New'
                              ? 'bg-emerald-500'
                              : 'bg-primary'
                        }`}
                      >
                        {product.badge}
                      </span>
                    )}

                    {/* Wishlist Button */}
                    <button
                      className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-muted-foreground opacity-0 shadow-md backdrop-blur-sm transition-all hover:bg-primary hover:text-white group-hover:opacity-100"
                      onClick={e => {
                        e.preventDefault();
                      }}
                    >
                      <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                        />
                      </svg>
                    </button>

                    {/* Image */}
                    <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100">
                      <div className="flex h-full items-center justify-center transition-transform duration-300 group-hover:scale-110">
                        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/10">
                          <svg
                            className="h-12 w-12 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      </div>

                      {/* Quick Actions */}
                      <div className="absolute inset-x-0 bottom-0 translate-y-full p-3 transition-transform duration-300 group-hover:translate-y-0">
                        <button
                          className="add-to-cart-btn"
                          onClick={e => {
                            e.preventDefault();
                          }}
                        >
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
                              d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                            />
                          </svg>
                          Add to Cart
                        </button>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-4">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {product.category}
                      </p>
                      <h3 className="mt-1 line-clamp-2 font-semibold text-foreground transition-colors group-hover:text-primary">
                        {product.name}
                      </h3>

                      {/* Rating */}
                      <div className="mt-2 flex items-center gap-2">
                        <StarRating rating={product.rating} />
                        <span className="text-xs text-muted-foreground">({product.reviews})</span>
                      </div>

                      {/* Price */}
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-lg font-bold text-primary">
                          {formatPrice(product.price)}
                        </span>
                        {product.compareAtPrice && (
                          <span className="text-sm text-muted-foreground line-through">
                            {formatPrice(product.compareAtPrice)}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* List View */}
            {viewMode === 'list' && (
              <div className="space-y-4">
                {filteredProducts.map(product => (
                  <Link
                    key={product.id}
                    href={`/products/${product.slug}`}
                    className="flex gap-4 rounded-2xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-lg"
                  >
                    {/* Image */}
                    <div className="relative h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-orange-50 to-orange-100">
                      {product.badge && (
                        <span
                          className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase text-white ${
                            product.badge === 'Sale'
                              ? 'bg-red-500'
                              : product.badge === 'New'
                                ? 'bg-emerald-500'
                                : 'bg-primary'
                          }`}
                        >
                          {product.badge}
                        </span>
                      )}
                      <div className="flex h-full items-center justify-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                          <svg
                            className="h-8 w-8 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="flex flex-1 flex-col justify-between">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {product.category}
                        </p>
                        <h3 className="mt-1 text-lg font-semibold text-foreground">
                          {product.name}
                        </h3>
                        <div className="mt-1 flex items-center gap-2">
                          <StarRating rating={product.rating} />
                          <span className="text-xs text-muted-foreground">
                            ({product.reviews} reviews)
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xl font-bold text-primary">
                            {formatPrice(product.price)}
                          </span>
                          {product.compareAtPrice && (
                            <span className="text-sm text-muted-foreground line-through">
                              {formatPrice(product.compareAtPrice)}
                            </span>
                          )}
                        </div>
                        <button
                          className="flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90"
                          onClick={e => {
                            e.preventDefault();
                          }}
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                            />
                          </svg>
                          Add to Cart
                        </button>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* No Results */}
            {filteredProducts.length === 0 && (
              <div className="py-16 text-center">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-muted">
                  <svg
                    className="h-10 w-10 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-foreground">No products found</h3>
                <p className="mt-1 text-muted-foreground">
                  Try adjusting your search or filter criteria
                </p>
                <button
                  onClick={() => {
                    setSearch('');
                    setCategory('All');
                  }}
                  className="mt-4 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
                >
                  Clear Filters
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
