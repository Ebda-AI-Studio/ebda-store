'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Header, Footer } from '../../components';

interface Product {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: Array<{ id: string; url: string; alt?: string }>;
  description?: string;
}

function SearchContent() {
  const searchParams = useSearchParams();
  const query = searchParams?.get('q') || '';
  const [searchTerm, setSearchTerm] = useState(query);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query) {
      setSearchTerm(query);
      performSearch(query);
    }
  }, [query]);

  async function performSearch(term: string) {
    if (!term.trim()) {
      setProducts([]);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await api.getProducts({ search: term });
      if (response.success && response.data) {
        setProducts(response.data.products || []);
      } else {
        setError(response.error?.message || 'Failed to search products');
      }
    } catch (err) {
      console.error('Search failed:', err);
      setError('Unable to search. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    performSearch(searchTerm);
    window.history.pushState({}, '', `/search?q=${encodeURIComponent(searchTerm)}`);
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-8">Search Products</h1>

        <form onSubmit={handleSearch} className="mb-8">
          <div className="flex gap-4 max-w-2xl">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search for products..."
              className="flex-1 px-4 py-3 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              type="submit"
              className="px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
            >
              Search
            </button>
          </div>
        </form>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <p className="text-red-700">{error}</p>
            </div>
            <button
              onClick={() => performSearch(searchTerm)}
              className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-gray-100 animate-pulse rounded-lg h-64"></div>
          ))}
        </div>
      ) : !error && products.length > 0 ? (
        <>
          <p className="text-gray-600 mb-6">
            {products.length} result{products.length !== 1 ? 's' : ''} for &quot;{query || searchTerm}&quot;
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {products.map((product) => (
              <Link
                key={product.id}
                href={`/products/${product.slug}`}
                className="group bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow"
              >
                <div className="aspect-square bg-gray-100 relative">
                  {product.images?.[0]?.url ? (
                    <img
                      src={product.images[0].url}
                      alt={product.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-gray-800 group-hover:text-blue-600 transition-colors line-clamp-2">
                    {product.name}
                  </h3>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="font-bold text-lg">${product.price.toFixed(2)}</span>
                    {product.compareAtPrice && product.compareAtPrice > product.price && (
                      <span className="text-gray-400 line-through text-sm">
                        ${product.compareAtPrice.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      ) : query ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">No products found for &quot;{query}&quot;</p>
          <Link href="/products" className="text-blue-600 hover:underline">
            Browse all products
          </Link>
        </div>
      ) : (
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
    <Suspense fallback={
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">Search Products</h1>
          <div className="animate-pulse bg-muted h-12 max-w-2xl rounded-lg"></div>
        </div>
        <Footer />
      </main>
    }>
      <SearchContent />
    </Suspense>
  );
}
