import type { Metadata } from 'next';
import { getStore } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import ProductsClient from './ProductsClient';

export const metadata: Metadata = {
  title: 'Products',
};

async function fetchInitialData(store: { id: string; domain?: string }) {
  const storeHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(store.domain ? { 'x-store-domain': store.domain } : {}),
  };

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
    <ProductsClient
      initialCategories={initialData.categories}
      initialProducts={initialData.products}
      initialMeta={initialData.meta}
    />
  );
}
