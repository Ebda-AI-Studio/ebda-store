'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type Product, type Category, type PaginationMeta } from '@/lib/api';
import { useCart } from '../../contexts/CartContext';
import { Header, Footer } from '../../components';
import { toggleCompare } from '@/lib/compare';

const sortOptions = [
  { value: 'featured', label: 'Featured' },
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
];

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
  }).format(fils / 1000);
}

function ProductSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-border bg-card overflow-hidden">
      <div className="aspect-square bg-muted" />
      <div className="p-4 space-y-3">
        <div className="h-3 w-16 rounded bg-muted" />
        <div className="h-4 w-3/4 rounded bg-muted" />
        <div className="h-3 w-20 rounded bg-muted" />
        <div className="h-5 w-24 rounded bg-muted" />
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [sortBy, setSortBy] = useState('newest');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track which product ids are in the compare list so buttons re-render on change
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const { addItem } = useCart();

  // Sync compare state from localStorage on mount (client-only)
  useEffect(() => {
    const ids = new Set(
      (() => {
        try {
          const raw = localStorage.getItem('compareProducts');
          return raw ? (JSON.parse(raw) as Array<{ id: string }>).map(p => p.id) : [];
        } catch {
          return [];
        }
      })()
    );
    setCompareIds(ids);
  }, []);

  const fetchProducts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        page: String(page),
        limit: '12',
      };
      if (search) params.search = search;
      if (categoryFilter) params.category = categoryFilter;
      if (sortBy === 'newest') params.sort = 'newest';
      if (sortBy === 'price-asc') params.sort = 'price_asc';
      if (sortBy === 'price-desc') params.sort = 'price_desc';
      if (sortBy === 'featured') params.featured = 'true';

      const response = await api.getProducts(params);
      if (response.success && response.data) {
        setProducts(response.data.products || []);
        setMeta(response.data.meta || null);
      } else {
        setError(response.error?.message || 'Failed to load products');
      }
    } catch {
      setError('Unable to load products. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }, [page, search, categoryFilter, sortBy]);

  const fetchCategories = useCallback(async () => {
    try {
      const response = await api.getCategories();
      if (response.success && response.data) {
        setCategories(response.data.categories || []);
      }
    } catch {
      // Categories are non-critical, fail silently
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [search, categoryFilter, sortBy]);

  const handleAddToCart = (product: Product, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      name: product.name,
      price: product.price,
      slug: product.slug,
      image: product.images?.[0]?.url,
      category: product.categories?.[0]?.name,
    });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchProducts();
  };

  const handleToggleCompare = (product: Product, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const result = toggleCompare({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      compareAtPrice: product.compareAtPrice,
      images: product.images?.map(img => img.url) ?? [],
    });
    if (result === 'max_reached') {
      alert('You can compare up to 4 products at a time. Remove one to add another.');
      return;
    }
    // Update local state to reflect the new compare list
    setCompareIds(prev => {
      const next = new Set(prev);
      if (result === 'added') {
        next.add(product.id);
      } else {
        next.delete(product.id);
      }
      return next;
    });
  };

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
              <form onSubmit={handleSearch}>
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
              </form>

              {/* Categories */}
              <div>
                <h3 className="mb-3 text-sm font-medium text-foreground">Categories</h3>
                <div className="space-y-2">
                  <button
                    onClick={() => setCategoryFilter('')}
                    className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm transition-all ${
                      !categoryFilter
                        ? 'bg-primary text-white shadow-md shadow-primary/25'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <span>All</span>
                    {meta && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          !categoryFilter ? 'bg-white/20' : 'bg-background'
                        }`}
                      >
                        {meta.total}
                      </span>
                    )}
                  </button>
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setCategoryFilter(cat.slug)}
                      className={`flex w-full items-center justify-between rounded-xl px-4 py-2.5 text-sm transition-all ${
                        categoryFilter === cat.slug
                          ? 'bg-primary text-white shadow-md shadow-primary/25'
                          : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span>{cat.name}</span>
                      {cat.productCount !== undefined && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            categoryFilter === cat.slug ? 'bg-white/20' : 'bg-background'
                          }`}
                        >
                          {cat.productCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Clear Filters */}
              <button
                onClick={() => {
                  setSearch('');
                  setCategoryFilter('');
                  setSortBy('newest');
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
                {isLoading ? (
                  'Loading...'
                ) : (
                  <>
                    Showing <span className="font-medium text-foreground">{products.length}</span>{' '}
                    {meta ? `of ${meta.total}` : ''} products
                  </>
                )}
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

            {/* Error State */}
            {error && (
              <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
                <div className="flex items-center gap-3">
                  <svg
                    className="h-5 w-5 text-red-500 flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <p className="text-red-700 flex-1">{error}</p>
                  <button
                    onClick={fetchProducts}
                    className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {[...Array(6)].map((_, i) => (
                  <ProductSkeleton key={i} />
                ))}
              </div>
            )}

            {/* Grid View */}
            {!isLoading && !error && viewMode === 'grid' && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {products.map((product, index) => (
                  <Link
                    key={product.id}
                    href={`/products/${product.slug}`}
                    className="product-card group"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    {/* Badge */}
                    {product.compareAtPrice && product.compareAtPrice > product.price && (
                      <span className="product-badge bg-red-500">Sale</span>
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

                    {/* Compare Button */}
                    <button
                      aria-label={
                        compareIds.has(product.id) ? 'Remove from compare' : 'Add to compare'
                      }
                      title={compareIds.has(product.id) ? 'Remove from compare' : 'Add to compare'}
                      className={`absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full shadow-md backdrop-blur-sm transition-all opacity-0 group-hover:opacity-100 ${
                        compareIds.has(product.id)
                          ? 'bg-primary text-white'
                          : 'bg-white/90 text-muted-foreground hover:bg-primary hover:text-white'
                      }`}
                      onClick={e => handleToggleCompare(product, e)}
                    >
                      {/* Bar-chart compare icon */}
                      <svg
                        className="h-4 w-4"
                        fill={compareIds.has(product.id) ? 'currentColor' : 'none'}
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={compareIds.has(product.id) ? 0 : 1.75}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                    </button>

                    {/* Image */}
                    <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100">
                      {product.images?.[0]?.url ? (
                        <img
                          src={product.images[0].url}
                          alt={product.images[0].alt || product.name}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
                        />
                      ) : (
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
                      )}

                      {/* Quick Actions */}
                      <div className="absolute inset-x-0 bottom-0 translate-y-full p-3 transition-transform duration-300 group-hover:translate-y-0">
                        <button
                          className="add-to-cart-btn"
                          onClick={e => handleAddToCart(product, e)}
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
                      {product.categories?.[0] && (
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {product.categories[0].name}
                        </p>
                      )}
                      <h3 className="mt-1 line-clamp-2 font-semibold text-foreground transition-colors group-hover:text-primary">
                        {product.name}
                      </h3>

                      {/* Price */}
                      <div className="mt-3 flex items-center gap-2">
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
            )}

            {/* List View */}
            {!isLoading && !error && viewMode === 'list' && (
              <div className="space-y-4">
                {products.map(product => (
                  <Link
                    key={product.id}
                    href={`/products/${product.slug}`}
                    className="flex gap-4 rounded-2xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-lg"
                  >
                    {/* Image */}
                    <div className="relative h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-orange-50 to-orange-100">
                      {product.compareAtPrice && product.compareAtPrice > product.price && (
                        <span className="absolute left-2 top-2 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                          Sale
                        </span>
                      )}
                      {product.images?.[0]?.url ? (
                        <img
                          src={product.images[0].url}
                          alt={product.images[0].alt || product.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
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
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex flex-1 flex-col justify-between">
                      <div>
                        {product.categories?.[0] && (
                          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                            {product.categories[0].name}
                          </p>
                        )}
                        <h3 className="mt-1 text-lg font-semibold text-foreground">
                          {product.name}
                        </h3>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xl font-bold text-primary">
                            {formatPrice(product.price)}
                          </span>
                          {product.compareAtPrice && product.compareAtPrice > product.price && (
                            <span className="text-sm text-muted-foreground line-through">
                              {formatPrice(product.compareAtPrice)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Compare button for list view */}
                          <button
                            aria-label={
                              compareIds.has(product.id) ? 'Remove from compare' : 'Add to compare'
                            }
                            title={
                              compareIds.has(product.id) ? 'Remove from compare' : 'Add to compare'
                            }
                            className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
                              compareIds.has(product.id)
                                ? 'border-primary bg-primary text-white'
                                : 'border-border bg-background text-muted-foreground hover:border-primary hover:text-primary'
                            }`}
                            onClick={e => handleToggleCompare(product, e)}
                          >
                            <svg
                              className="h-4 w-4"
                              fill={compareIds.has(product.id) ? 'currentColor' : 'none'}
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={compareIds.has(product.id) ? 0 : 1.75}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                              />
                            </svg>
                          </button>

                          <button
                            className="flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90"
                            onClick={e => handleAddToCart(product, e)}
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
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* No Results */}
            {!isLoading && !error && products.length === 0 && (
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
                    setCategoryFilter('');
                  }}
                  className="mt-4 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
                >
                  Clear Filters
                </button>
              </div>
            )}

            {/* Pagination */}
            {meta && meta.totalPages > 1 && (
              <div className="mt-8 flex items-center justify-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                {Array.from({ length: meta.totalPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === meta.totalPages || Math.abs(p - page) <= 1)
                  .map((p, i, arr) => {
                    const showEllipsis = i > 0 && p - arr[i - 1] > 1;
                    return (
                      <span key={p} className="flex items-center gap-2">
                        {showEllipsis && <span className="px-1 text-muted-foreground">...</span>}
                        <button
                          onClick={() => setPage(p)}
                          className={`flex h-10 w-10 items-center justify-center rounded-lg text-sm font-medium transition-colors ${
                            page === p
                              ? 'bg-primary text-white'
                              : 'border border-border hover:bg-muted'
                          }`}
                        >
                          {p}
                        </button>
                      </span>
                    );
                  })}
                <button
                  onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                  disabled={page === meta.totalPages}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
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
