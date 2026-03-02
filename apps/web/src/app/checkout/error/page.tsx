'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@force/ui';
import { useStoreUrl } from '../../../contexts/StoreContext';

export default function CheckoutErrorPage() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const [isRetrying, setIsRetrying] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  // Read URL params on the client side (this is a client component)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOrderId(params.get('orderId'));
    setPaymentId(params.get('paymentId'));
  }, []);

  function handleRetryPayment() {
    setIsRetrying(true);

    // Build the checkout URL, attaching orderId and paymentId if available so
    // the checkout page can pre-populate or resume the correct order.
    const query = new URLSearchParams();
    if (orderId) query.set('orderId', orderId);
    if (paymentId) query.set('paymentId', paymentId);

    const destination = query.toString() ? `/checkout?${query.toString()}` : '/checkout';

    router.push(storeUrl(destination));
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md text-center">
        <Link href={storeUrl('/')} className="inline-flex items-center gap-2 mb-8">
          <Image src="/logo.svg" alt="Force Media" width={48} height={36} />
          <span className="text-2xl font-bold">
            <span className="text-primary">Force</span>
            <span className="text-foreground"> Store</span>
          </span>
        </Link>

        <div className="rounded-xl border bg-white p-8 shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg
              className="h-8 w-8 text-red-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>

          <h1 className="mt-6 text-2xl font-bold text-foreground">
            Payment could not be processed
          </h1>
          <p className="mt-2 text-muted-foreground">
            Something went wrong during checkout. Please try again or contact support if the problem
            persists.
          </p>

          <div className="mt-8 flex flex-col gap-3">
            {/* Retry Payment — redirects back to checkout with orderId/paymentId so the
                checkout page can resume the same order rather than creating a duplicate. */}
            <Button
              className="w-full"
              size="lg"
              onClick={handleRetryPayment}
              isLoading={isRetrying}
            >
              Retry Payment
            </Button>

            <Link href={storeUrl('/cart')}>
              <Button className="w-full" size="lg" variant="outline">
                Return to Cart
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
