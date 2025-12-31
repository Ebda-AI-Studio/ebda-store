'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';

interface CompareProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  description?: string;
  specifications?: Record<string, string>;
}

// Load compare products from localStorage
function loadInitialProducts(): CompareProduct[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem('compareProducts');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load compare products:', error);
  }
  return [];
}

export default function ComparePage() {
  const [products, setProducts] = useState<CompareProduct[]>(() => loadInitialProducts());
  const [isLoading] = useState(false);

  function removeProduct(productId: string) {
    const updated = products.filter(p => p.id !== productId);
    setProducts(updated);
    localStorage.setItem('compareProducts', JSON.stringify(updated));
  }

  function clearAll() {
    setProducts([]);
    localStorage.removeItem('compareProducts');
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">Compare Products</h1>
          <div className="animate-pulse bg-gray-100 h-96 rounded-lg"></div>
        </div>
        <Footer />
      </main>
    );
  }

  if (products.length === 0) {
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">Compare Products</h1>
          <div className="text-center py-12 bg-gray-50 rounded-lg">
            <svg
              className="w-16 h-16 text-gray-400 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">No products to compare</h2>
            <p className="text-gray-500 mb-4">Add products to compare their features</p>
            <Link
              href="/products"
              className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              Browse Products
            </Link>
          </div>
        </div>
        <Footer />
      </main>
    );
  }

  // Get all unique specification keys
  const allSpecs = new Set<string>();
  products.forEach(p => {
    if (p.specifications) {
      Object.keys(p.specifications).forEach(key => allSpecs.add(key));
    }
  });

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Compare Products</h1>
          <button onClick={clearAll} className="text-red-600 hover:text-red-700 text-sm">
            Clear All
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr>
                <th className="text-left p-4 bg-gray-50 w-1/4">Product</th>
                {products.map(product => (
                  <th key={product.id} className="p-4 bg-gray-50">
                    <div className="relative">
                      <button
                        onClick={() => removeProduct(product.id)}
                        className="absolute -top-2 -right-2 p-1 bg-red-100 rounded-full text-red-600 hover:bg-red-200"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                      <Link href={`/products/${product.slug}`}>
                        <div className="w-32 h-32 mx-auto bg-gray-100 rounded-lg overflow-hidden mb-2">
                          {product.images?.[0] ? (
                            <img
                              src={product.images[0]}
                              alt={product.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400">
                              <svg
                                className="w-8 h-8"
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
                        </div>
                        <h3 className="font-semibold text-sm hover:text-blue-600 line-clamp-2">
                          {product.name}
                        </h3>
                      </Link>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="p-4 font-medium text-gray-600">Price</td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center">
                    <span className="font-bold text-lg">${product.price.toFixed(2)}</span>
                    {product.compareAtPrice && product.compareAtPrice > product.price && (
                      <span className="block text-gray-400 line-through text-sm">
                        ${product.compareAtPrice.toFixed(2)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
              <tr className="border-t">
                <td className="p-4 font-medium text-gray-600">Description</td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center text-sm text-gray-600">
                    {product.description ? (
                      <p className="line-clamp-3">{product.description}</p>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                ))}
              </tr>
              {Array.from(allSpecs).map(spec => (
                <tr key={spec} className="border-t">
                  <td className="p-4 font-medium text-gray-600">{spec}</td>
                  {products.map(product => (
                    <td key={product.id} className="p-4 text-center text-sm">
                      {product.specifications?.[spec] || <span className="text-gray-400">-</span>}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t">
                <td className="p-4"></td>
                {products.map(product => (
                  <td key={product.id} className="p-4 text-center">
                    <button className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                      Add to Cart
                    </button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <Footer />
    </main>
  );
}
