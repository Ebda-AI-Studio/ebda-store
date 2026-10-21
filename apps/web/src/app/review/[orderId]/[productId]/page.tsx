import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { notFound } from 'next/navigation';
import { ReviewForm } from './ReviewForm';
import { ReviewErrorView } from './ReviewErrorView';
import { API_URL } from '../../../../lib/api';

interface ReviewProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  images?: string[] | null;
  storeId: string;
}

interface ReviewStore {
  name: string;
  nameAr?: string | null;
  slug: string;
  logo?: string | null;
}

// Track-B (order-specific, must stay per-request) — see
// app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Submit Review', 'إضافة تقييم'],
    robots: { index: false, follow: false },
  });
}

interface PageProps {
  params: Promise<{ orderId: string; productId: string }>;
  searchParams: Promise<{ token?: string }>;
}

export default async function ReviewPage({ params, searchParams }: PageProps) {
  const { orderId, productId } = await params;
  const { token } = await searchParams;

  if (!token) notFound();

  let canSubmitData: { product: ReviewProduct; store: ReviewStore } | null = null;
  let errorCode: string | null = null;

  try {
    // API_URL already includes the /api/v1 prefix (see lib/api.ts) — do not
    // re-append it here or the request 404s on /api/v1/api/v1/...
    const res = await fetch(
      `${API_URL}/public/reviews/can-submit?orderId=${encodeURIComponent(orderId)}&productId=${encodeURIComponent(productId)}&token=${encodeURIComponent(token)}`,
      { cache: 'no-store' }
    );

    const body = await res.json().catch(() => ({ error: 'UNKNOWN' }));

    if (!res.ok || !body.ok) {
      errorCode = body.error || 'UNKNOWN';
    } else {
      canSubmitData = { product: body.product, store: body.store };
    }
  } catch {
    errorCode = 'NETWORK';
  }

  if (errorCode) {
    return <ReviewErrorView error={errorCode} />;
  }

  return (
    <ReviewForm
      orderId={orderId}
      productId={productId}
      token={token}
      product={canSubmitData!.product}
      store={canSubmitData!.store}
    />
  );
}
