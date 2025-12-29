'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Input, Badge } from '@force/ui';
import { Header, Footer } from '../../components';

// Demo products data
const products = [
  { id: '1', name: 'Premium Wireless Headphones', slug: 'premium-wireless-headphones', price: 29900, compareAtPrice: 34900, category: 'Electronics', image: '/placeholder.svg', badge: 'Sale' },
  { id: '2', name: 'Smart Watch Pro', slug: 'smart-watch-pro', price: 39900, compareAtPrice: 44900, category: 'Wearables', image: '/placeholder.svg', badge: 'New' },
  { id: '3', name: 'USB-C Hub 7-in-1', slug: 'usb-c-hub-7-in-1', price: 7900, category: 'Accessories', image: '/placeholder.svg' },
  { id: '4', name: 'Wireless Mechanical Keyboard', slug: 'wireless-mechanical-keyboard', price: 14900, compareAtPrice: 17900, category: 'Accessories', image: '/placeholder.svg', badge: 'Popular' },
  { id: '5', name: 'Portable Bluetooth Speaker', slug: 'portable-bluetooth-speaker', price: 12900, category: 'Electronics', image: '/placeholder.svg' },
  { id: '6', name: 'Fitness Tracker Band', slug: 'fitness-tracker-band', price: 9900, compareAtPrice: 12900, category: 'Wearables', image: '/placeholder.svg', badge: 'Sale' },
  { id: '7', name: '4K Webcam Pro', slug: '4k-webcam-pro', price: 19900, category: 'Electronics', image: '/placeholder.svg' },
  { id: '8', name: 'Ergonomic Mouse', slug: 'ergonomic-mouse', price: 8900, category: 'Accessories', image: '/placeholder.svg' },
];

const categories = ['All', 'Electronics', 'Accessories', 'Wearables'];

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export default function ProductsPage() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  const filteredProducts = products.filter(product => {
    const matchesSearch = product.name.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = category === 'All' || product.category === category;
    return matchesSearch && matchesCategory;
  });

  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">All Products</h1>
          <p className="mt-2 text-gray-500">Browse our collection of premium products</p>
        </div>

        {/* Filters */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  category === cat
                    ? 'bg-primary text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="w-full sm:w-64">
            <Input
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Products Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {filteredProducts.map(product => (
            <Link
              key={product.id}
              href={`/products/${product.slug}`}
              className="group relative overflow-hidden rounded-xl border bg-white shadow-sm transition hover:shadow-lg"
            >
              {product.badge && (
                <div className="absolute left-3 top-3 z-10">
                  <Badge variant={product.badge === 'Sale' ? 'destructive' : 'default'}>
                    {product.badge}
                  </Badge>
                </div>
              )}
              <div className="aspect-square overflow-hidden bg-gradient-to-br from-orange-50 to-orange-100">
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <div className="mx-auto mb-2 flex h-20 w-20 items-center justify-center rounded-full bg-primary/20">
                      <svg className="h-10 w-10 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
              <div className="p-4">
                <p className="text-xs text-gray-500">{product.category}</p>
                <h3 className="mt-1 font-medium text-gray-900 group-hover:text-primary">
                  {product.name}
                </h3>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-lg font-bold text-primary">
                    {formatPrice(product.price)}
                  </span>
                  {product.compareAtPrice && (
                    <span className="text-sm text-gray-400 line-through">
                      {formatPrice(product.compareAtPrice)}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>

        {filteredProducts.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-gray-500">No products found matching your criteria.</p>
          </div>
        )}
      </div>

      <Footer />
    </main>
  );
}
