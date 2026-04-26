import type { MetadataRoute } from 'next';
import { getSiteUrl } from '../lib/structured-data';
import { API_URL } from '../lib/api';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl();

  // Try to resolve store for API headers — gracefully degrade if unavailable
  const storeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { getStore } = await import('../lib/store-resolver');
    const store = await getStore();
    if (store.domain) storeHeaders['x-store-domain'] = store.domain;
    if (store.id && store.id !== 'demo') storeHeaders['X-Store-ID'] = store.id;
  } catch {
    // Store resolution failed — static pages only
  }

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: siteUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${siteUrl}/products`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${siteUrl}/categories`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${siteUrl}/about`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${siteUrl}/contact`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${siteUrl}/faq`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/shipping`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/returns`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${siteUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
    {
      url: `${siteUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];

  // Fetch published products
  let productPages: MetadataRoute.Sitemap = [];
  let categoryPages: MetadataRoute.Sitemap = [];

  try {
    const [productsRes, categoriesRes] = await Promise.all([
      fetch(`${API_URL}/public/products?limit=1000&status=published`, {
        next: { revalidate: 3600 },
        headers: storeHeaders,
      }),
      fetch(`${API_URL}/public/categories`, {
        next: { revalidate: 3600 },
        headers: storeHeaders,
      }),
    ]);

    if (productsRes.ok) {
      const productsData = await productsRes.json();
      const products = productsData?.data?.products ?? [];
      productPages = products.map(
        (product: { slug: string; updatedAt?: string; createdAt?: string }) => ({
          url: `${siteUrl}/products/${product.slug}`,
          lastModified: product.updatedAt
            ? new Date(product.updatedAt)
            : product.createdAt
              ? new Date(product.createdAt)
              : new Date(),
          changeFrequency: 'weekly' as const,
          priority: 0.7,
        })
      );
    }

    if (categoriesRes.ok) {
      const categoriesData = await categoriesRes.json();
      const categories = categoriesData?.data?.categories ?? [];
      categoryPages = categories.map((category: { slug: string }) => ({
        url: `${siteUrl}/categories?category=${category.slug}`,
        lastModified: new Date(),
        changeFrequency: 'weekly' as const,
        priority: 0.6,
      }));
    }
  } catch (error) {
    console.error('Error generating sitemap:', error);
  }

  return [...staticPages, ...productPages, ...categoryPages];
}
