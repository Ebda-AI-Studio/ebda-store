'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStoreUrl } from '@/contexts/StoreContext';
import { Header, Footer } from '../../components';

interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  productCount?: number;
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const storeUrl = useStoreUrl();

  useEffect(() => {
    loadCategories();
  }, []);

  async function loadCategories() {
    try {
      const response = await api.getCategories();
      if (response.success && response.data) {
        setCategories(response.data.categories || []);
      }
    } catch (error) {
      console.error('Failed to load categories:', error);
    } finally {
      setIsLoading(false);
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">Categories</h1>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-gray-100 animate-pulse rounded-lg h-48"></div>
            ))}
          </div>
        </div>
        <Footer />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-8">Shop by Category</h1>

        {categories.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 mb-4">No categories available yet.</p>
            <Link href={storeUrl('/products')} className="text-primary hover:underline">
              Browse all products
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {categories.map(category => (
              <Link
                key={category.id}
                href={storeUrl(`/products?category=${category.slug}`)}
                className="group bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow border"
              >
                <div className="aspect-square bg-gradient-to-br from-primary/5 to-primary/10 relative">
                  {category.image ? (
                    <img
                      src={category.image}
                      alt={category.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-primary/50">
                      <svg
                        className="w-16 h-16"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                        />
                      </svg>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">
                    {category.name}
                  </h3>
                  {category.description && (
                    <p className="text-muted-foreground text-sm mt-1 line-clamp-2">
                      {category.description}
                    </p>
                  )}
                  {category.productCount !== undefined && (
                    <p className="text-muted-foreground/70 text-sm mt-2">
                      {category.productCount} products
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      <Footer />
    </main>
  );
}
