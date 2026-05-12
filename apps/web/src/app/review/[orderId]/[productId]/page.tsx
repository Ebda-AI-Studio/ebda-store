import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReviewForm } from './ReviewForm';
import { ReviewErrorView } from './ReviewErrorView';

export const metadata: Metadata = {
  title: 'Submit Review',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ orderId: string; productId: string }>;
  searchParams: Promise<{ token?: string }>;
}

export default async function ReviewPage({ params, searchParams }: PageProps) {
  const { orderId, productId } = await params;
  const { token } = await searchParams;

  if (!token) notFound();

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://store-api.forcemediakw.com';
  let canSubmitData: { product: any; store: any } | null = null;
  let errorCode: string | null = null;

  try {
    const res = await fetch(
      `${apiUrl}/api/v1/public/reviews/can-submit?orderId=${encodeURIComponent(orderId)}&productId=${encodeURIComponent(productId)}&token=${encodeURIComponent(token)}`,
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
