'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type Category } from '@/lib/api';
import { Header, Footer } from '../../components';
import { trackSearch } from '../../components/MarketingPixels';

interface Product {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: Array<{ id: string; url: string; alt?: string }>;
  description?: string;
  categories?: Array<{ id: string; name: string }>;
  createdAt?: string;
}

const sortOptions = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'name-asc', label: 'Name A-Z' },
] as const;

type SortValue = (typeof sortOptions)[number]['value'];

/** Sort products client-side so the UI responds instantly. */
function sortProducts(products: Product[], sortBy: SortValue): Product[] {
  const copy = [...products];
  switch (sortBy) {
    case 'price-asc':
      return copy.sort((a, b) => a.price - b.price);
    case 'price-desc':
      return copy.sort((a, b) => b.price - a.price);
    case 'name-asc':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case 'newest':
    default:
      return copy.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
        return 0;
      });
  }
}

function SearchContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Derive initial values from URL params for shareability
  const committedQuery = searchParams?.get('q') || '';
  const committedCategory = searchParams?.get('category') || '';
  const committedSort = (searchParams?.get('sort') as SortValue | null) || 'newest';

  const [searchTerm, setSearchTerm] = useState(committedQuery);
  const [categoryFilter, setCategoryFilter] = useState(committedCategory);
  const [sortBy, setSortBy] = useState<SortValue>(committedSort);

  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch categories once on mount (non-critical)
  useEffect(() => {
    api
      .getCategories()
      .then(res => {
        if (res.success && res.data) setCategories(res.data.categories || []);
      })
      .catch(() => undefined);
  }, []);

  const performSearch = useCallback(async (term: string, category: string) => {
    if (!term.trim()) {
      setAllProducts([]);
      return;
    }
    setIsLoading(true);
    setError(null);

    // Fire Search pixel event whenever a search is performed
    trackSearch({ searchString: term });

    try {
      const params: Record<string, string> = { search: term };
      if (category) params.category = category;
      const response = await api.getProducts(params);
      if (response.success && response.data) {
        setAllProducts(response.data.products || []);
      } else {
        setError(response.error?.message || 'Failed to search products');
      }
    } catch {
      setError('Unable to search. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Re-run search when URL params change
  useEffect(() => {
    if (committedQuery) {
      setSearchTerm(committedQuery);
      setCategoryFilter(committedCategory);
      setSortBy(committedSort);
      performSearch(committedQuery, committedCategory);
    }
  }, [committedQuery, committedCategory, committedSort, performSearch]);

  /** Update URL params so filters are shareable / back-button-friendly. */
  function pushParams(term: string, category: string, sort: SortValue) {
    const params = new URLSearchParams();
    if (term) params.set('q', term);
    if (category) params.set('category', category);
    if (sort && sort !== 'newest') params.set('sort', sort);
    router.push(`/search?${params.toString()}`);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    pushParams(searchTerm, categoryFilter, sortBy);
  }

  function handleCategoryChange(value: string) {
    setCategoryFilter(value);
    if (committedQuery) pushParams(committedQuery, value, sortBy);
  }

  function handleSortChange(value: SortValue) {
    setSortBy(value);
    if (committedQuery) pushParams(committedQuery, categoryFilter, value);
  }

  // Apply client-side sort; category filter already sent to API but also applied locally
  // so switching category without re-fetching gives instant feedback.
  const filtered = categoryFilter
    ? allProducts.filter(p =>
        p.categories?.some(c => c.id === categoryFilter || c.name === categoryFilter)
      )
    : allProducts;
  const products = sortProducts(filtered, sortBy);

  const displayQuery = committedQuery || searchTerm;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-6">Search Products</h1>

        {/* Search form */}
        <form onSubmit={handleSearch} className="mb-6">
          <div className="flex gap-3 max-w-2xl">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search for products..."
              className="flex-1 px-4 py-3 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
            />
            <button
              type="submit"
              className="px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
            >
              Search
            </button>
          </div>
        </form>

        {/* Filter & Sort bar — visible when categories exist or a query was submitted */}
        {(categories.length > 0 || committedQuery) && (
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-muted/30 p-4">
            {/* Category filter */}
            {categories.length > 0 && (
              <div className="flex items-center gap-2">
                <label
                  htmlFor="search-category"
                  className="text-sm font-medium text-muted-foreground whitespace-nowrap"
                >
                  Category:
                </label>
                <select
                  id="search-category"
                  value={categoryFilter}
                  onChange={e => handleCategoryChange(e.target.value)}
                  className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">All Categories</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Sort */}
            <div className="flex items-center gap-2">
              <label
                htmlFor="search-sort"
                className="text-sm font-medium text-muted-foreground whitespace-nowrap"
              >
                Sort by:
              </label>
              <select
                id="search-sort"
                value={sortBy}
                onChange={e => handleSortChange(e.target.value as SortValue)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                {sortOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Removable category chip */}
            {categoryFilter && (
              <button
                onClick={() => handleCategoryChange('')}
                className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                {categories.find(c => c.id === categoryFilter)?.name ?? categoryFilter}
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
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
                onClick={() => performSearch(committedQuery, categoryFilter)}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Loading skeletons */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-muted animate-pulse rounded-lg h-64" />
            ))}
          </div>
        )}

        {/* Results grid */}
        {!isLoading && !error && products.length > 0 && (
          <>
            <p className="text-muted-foreground mb-6 text-sm">
              {products.length} result{products.length !== 1 ? 's' : ''} for &quot;
              {displayQuery}&quot;
              {categoryFilter && (
                <>
                  {' '}
                  in{' '}
                  <span className="font-medium text-foreground">
                    {categories.find(c => c.id === categoryFilter)?.name ?? categoryFilter}
                  </span>
                </>
              )}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {products.map(product => (
                <Link
                  key={product.id}
                  href={`/products/${product.slug}`}
                  className="group rounded-xl border border-border bg-card overflow-hidden hover:shadow-lg transition-shadow"
                >
                  <div className="aspect-square bg-gradient-to-br from-orange-50 to-orange-100 relative overflow-hidden">
                    {product.images?.[0]?.url ? (
                      <img
                        src={product.images[0].url}
                        alt={product.images[0].alt || product.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        <svg
                          className="w-12 h-12"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                    {product.compareAtPrice && product.compareAtPrice > product.price && (
                      <span className="absolute top-2 left-2 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                        Sale
                      </span>
                    )}
                  </div>
                  <div className="p-4">
                    {product.categories?.[0] && (
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">
                        {product.categories[0].name}
                      </p>
                    )}
                    <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-2">
                      {product.name}
                    </h3>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="font-bold text-lg text-primary">
                        {(product.price / 1000).toFixed(3)} KWD
                      </span>
                      {product.compareAtPrice && product.compareAtPrice > product.price && (
                        <span className="text-muted-foreground line-through text-sm">
                          {(product.compareAtPrice / 1000).toFixed(3)} KWD
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {/* No results */}
        {!isLoading && !error && committedQuery && products.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-3">
              No products found for &quot;{committedQuery}&quot;
              {categoryFilter ? ' in the selected category' : ''}
            </p>
            {categoryFilter && (
              <button
                onClick={() => handleCategoryChange('')}
                className="block mx-auto mb-3 text-sm text-primary hover:underline"
              >
                Clear category filter
              </button>
            )}
            <Link href="/products" className="text-primary hover:underline text-sm">
              Browse all products
            </Link>
          </div>
        )}

        {/* Empty state when no query entered yet */}
        {!isLoading && !error && !committedQuery && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Enter a search term to find products</p>
          </div>
        )}
      </div>
      <Footer />
    </main>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen flex-col bg-background">
          <Header />
          <div className="container mx-auto px-4 py-8 flex-1">
            <h1 className="text-3xl font-bold mb-8">Search Products</h1>
            <div className="animate-pulse bg-muted h-12 max-w-2xl rounded-lg" />
          </div>
          <Footer />
        </main>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
