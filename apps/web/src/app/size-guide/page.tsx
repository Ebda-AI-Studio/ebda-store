import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { toPublicSizeChart, type PublicSizeChart } from '@ebda/shared';
import { getStoreOrNotFound } from '../../lib/store-resolver';
import { API_URL } from '../../lib/api';
import SizeGuideClient from './SizeGuideClient';

export const metadata: Metadata = {
  title: 'Size guide',
  description: 'Size charts for our products.',
};

/**
 * /size-guide (B0 Task 9): every size chart of the store on one page, so a merchant can link it
 * from the navigation editor. 404 when the store has none (no empty storefront states).
 * Same `products:<store>` data-cache tag as the PDP, which every chart write purges.
 */
async function fetchSizeCharts(store: { id: string; domain?: string | null }) {
  if (!store.id || store.id === 'demo') return [];
  try {
    const res = await fetch(`${API_URL}/public/size-charts`, {
      next: { revalidate: 60, tags: [`products:${store.id}`] },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': store.id,
        ...(store.domain ? { 'x-store-domain': store.domain } : {}),
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const raw: unknown[] = Array.isArray(json?.data?.sizeCharts) ? json.data.sizeCharts : [];
    return raw.map(toPublicSizeChart).filter((c): c is PublicSizeChart => c !== null);
  } catch {
    return [];
  }
}

export default async function SizeGuidePage() {
  const store = await getStoreOrNotFound();
  const charts = await fetchSizeCharts(store);
  if (charts.length === 0) notFound();
  return <SizeGuideClient charts={charts} />;
}
