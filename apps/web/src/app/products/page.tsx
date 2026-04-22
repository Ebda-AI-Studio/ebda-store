import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getStore } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import ProductsClient from './ProductsClient';

export const metadata: Metadata = {
  title: 'Products',
  description:
    'Browse our full catalog of products. Find the best deals with fast delivery in Kuwait.',
};

async function fetchInitialData(store: { id: string; domain?: string }) {
  // Always send X-Store-ID so the API doesn't fall back to some other store.
  // x-store-domain is kept as a backup for logging/debugging.
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Store-ID': store.id,
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };

  // No valid store id — bail with empty data rather than 400-ing the SSR pass.
  if (!store.id || store.id === 'demo') {
    return { categories: [], products: [], meta: null };
  }

  // Fetch categories and first page of products in parallel
  const [categoriesResult, productsResult] = await Promise.all([
    fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${API_URL}/public/products?page=1&limit=12&sort=newest`, {
      next: { revalidate: 60 },
      headers: storeHeaders,
    })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  return {
    categories: categoriesResult?.data?.categories ?? [],
    products: productsResult?.data?.products ?? [],
    meta: productsResult?.data?.meta ?? null,
  };
}

export default async function ProductsPage() {
  const store = await getStore();
  const initialData = await fetchInitialData(store);

  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-background">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </main>
      }
    >
      <ProductsClient
        initialCategories={initialData.categories}
        initialProducts={initialData.products}
        initialMeta={initialData.meta}
      />
    </Suspense>
  );
}
