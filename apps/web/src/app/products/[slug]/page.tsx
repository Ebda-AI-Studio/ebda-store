import type { Metadata } from 'next';
import { getStore, getStoreOrNotFound } from '../../../lib/store-resolver';
import { API_URL } from '../../../lib/api';
import {
  productJsonLd,
  breadcrumbJsonLd,
  faqPageJsonLd,
  getSiteUrl,
} from '../../../lib/structured-data';
import { JsonLd } from '../../../components/JsonLd';
import ProductDetailClient from './ProductDetailClient';

/**
 * Server-side metadata for product pages.
 * Fetches product data to populate title, description, and og:image
 * so that search engines and social previews get the correct content
 * without waiting for client-side hydration.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStore();

  // Fetch product data server-side for meta tags
  try {
    const storeId = store.id !== 'demo' ? store.id : null;
    if (!storeId) {
      return { title: 'Product' };
    }

    const response = await fetch(
      `${API_URL}/stores/${storeId}/products/${encodeURIComponent(slug)}`,
      { next: { revalidate: 60 } }
    );

    if (!response.ok) {
      // Fall back to public endpoint
      const publicResponse = await fetch(`${API_URL}/public/products/${encodeURIComponent(slug)}`, {
        next: { revalidate: 60 },
        headers: {
          'Content-Type': 'application/json',
          'X-Store-ID': store.id,
          ...(store.domain ? { 'x-store-domain': store.domain } : {}),
        },
      });

      if (!publicResponse.ok) {
        return { title: 'Product Not Found' };
      }

      const publicData = await publicResponse.json();
      const product = publicData?.data?.product;
      if (!product) {
        return { title: 'Product Not Found' };
      }

      return buildProductMetadata(product, store.name);
    }

    const data = await response.json();
    const product = data?.data?.product;
    if (!product) {
      return { title: 'Product Not Found' };
    }

    return buildProductMetadata(product, store.name);
  } catch {
    // On any fetch error, return minimal metadata
    return { title: 'Product' };
  }
}

interface ProductData {
  name: string;
  description?: string;
  price: number;
  images?: Array<{ url: string; alt?: string }>;
  categories?: Array<{ category?: { name?: string } }>;
}

function buildProductMetadata(product: ProductData, storeName: string): Metadata {
  const title = product.name;
  const description =
    product.description?.slice(0, 160) ||
    `Buy ${product.name} at ${storeName}. Fast delivery in Kuwait.`;
  const ogImage = product.images?.[0]?.url;
  const category = product.categories?.[0]?.category?.name;

  return {
    title,
    description,
    openGraph: {
      title: `${title} | ${storeName}`,
      description,
      type: 'website',
      ...(ogImage ? { images: [{ url: ogImage, alt: product.name }] } : {}),
    },
    other: {
      ...(category ? { 'product:category': category } : {}),
      'product:price:amount': String(product.price / 1000),
      'product:price:currency': 'KWD',
    },
  };
}

async function fetchInitialProduct(slug: string, store: { id: string; domain?: string }) {
  try {
    const storeId = store.id !== 'demo' ? store.id : null;
    if (!storeId) return null;

    const response = await fetch(
      `${API_URL}/stores/${storeId}/products/${encodeURIComponent(slug)}`,
      { next: { revalidate: 60 } }
    );

    if (!response.ok) {
      const publicResponse = await fetch(`${API_URL}/public/products/${encodeURIComponent(slug)}`, {
        next: { revalidate: 60 },
        headers: {
          'Content-Type': 'application/json',
          'X-Store-ID': store.id,
          ...(store.domain ? { 'x-store-domain': store.domain } : {}),
        },
      });
      if (!publicResponse.ok) return null;
      const publicData = await publicResponse.json();
      return publicData?.data?.product ?? null;
    }

    const data = await response.json();
    return data?.data?.product ?? null;
  } catch {
    return null;
  }
}

export default async function ProductDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, store] = await Promise.all([params, getStoreOrNotFound()]);
  const initialProduct = await fetchInitialProduct(slug, store);

  const siteUrl = getSiteUrl(store);

  // Per-product FAQ JSON-LD (separate FAQPage block alongside the Product block)
  const productFaqItems: Array<{ question: string; answer: string }> =
    initialProduct?.faqs?.length > 0
      ? initialProduct.faqs.map((f: { question: string; answer: string }) => ({
          question: f.question,
          answer: f.answer,
        }))
      : [];

  const jsonLdScripts = initialProduct
    ? [
        productJsonLd(initialProduct, store),
        breadcrumbJsonLd([
          { name: 'Home', url: siteUrl },
          { name: 'Products', url: `${siteUrl}/products` },
          { name: initialProduct.name, url: `${siteUrl}/products/${initialProduct.slug}` },
        ]),
        ...(productFaqItems.length > 0 ? [faqPageJsonLd(productFaqItems)] : []),
      ]
    : [];

  return (
    <>
      {jsonLdScripts.map((jsonLd, i) => (
        <JsonLd key={i} data={jsonLd} />
      ))}
      <ProductDetailClient initialProduct={initialProduct} />
    </>
  );
}
