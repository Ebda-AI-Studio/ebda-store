import type { Metadata } from 'next';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { API_URL, type Category } from '@/lib/api';
import { breadcrumbJsonLd, itemList, getSiteUrl } from '../../lib/structured-data';
import { JsonLd } from '../../components/JsonLd';
import CategoriesClient from './CategoriesClient';

export const metadata: Metadata = {
  title: 'Categories',
  description: 'Explore product categories and find exactly what you are looking for.',
};

/**
 * Fetch categories server-side so the page renders with data immediately,
 * eliminating the client-side loading spinner on first paint.
 */
async function fetchCategories(store: { id: string; domain?: string }): Promise<Category[]> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // For store-aware routing, pass the domain header so the public endpoint
    // returns categories scoped to this store.
    if (store.domain) {
      headers['x-store-domain'] = store.domain;
    }
    if (store.id && store.id !== 'demo') {
      headers['X-Store-ID'] = store.id;
    }

    const response = await fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 60 },
      headers,
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (data.success && data.data?.categories) {
      return data.data.categories;
    }
    return [];
  } catch {
    return [];
  }
}

export default async function CategoriesPage() {
  const store = await getStoreOrNotFound();
  const categories = await fetchCategories(store);

  const siteUrl = getSiteUrl(store);

  const categoriesBreadcrumb = breadcrumbJsonLd([
    { name: 'Home', url: siteUrl },
    { name: 'Categories', url: `${siteUrl}/categories` },
  ]);

  // Represent each category as an ItemList entry so AI agents understand
  // the taxonomy without crawling each category page individually.
  const categoriesItemList =
    categories.length > 0
      ? itemList(
          categories.slice(0, 50).map((c: Category) => ({
            name: c.name,
            url: `${siteUrl}/categories/${c.slug}`,
            image: c.image ?? null,
            price: null,
          })),
          'Product Categories'
        )
      : null;

  return (
    <>
      {/* JSON-LD: Breadcrumb + optional ItemList of categories */}
      <JsonLd data={categoriesBreadcrumb} />
      {categoriesItemList && <JsonLd data={categoriesItemList} />}
      <CategoriesClient categories={categories} />
    </>
  );
}
