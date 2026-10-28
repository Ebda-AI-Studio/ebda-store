'use client';

import { useState, useEffect } from 'react';
import Link from '../../../components/StoreLink';
import { useRouter } from 'next/navigation';
import { Button } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function ErrorClient() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [isRetrying, setIsRetrying] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  // Start in the "verifying" state whenever the URL carries an orderId — we
  // must NOT show a Retry button (which mints a brand-new order + charge)
  // until we've confirmed the original payment did NOT actually capture. A
  // gateway can redirect here on a 3DS timeout / slow-settling capture even
  // though the charge went through; showing Retry then = double charge →
  // chargeback (the classic untested-flow money bug).
  const [isVerifying, setIsVerifying] = useState(false);

  // Read URL params + verify the original payment before rendering anything.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oid = params.get('orderId');
    const pid = params.get('paymentId');
    setOrderId(oid);
    setPaymentId(pid);

    if (!oid) return; // no order to verify — show the generic error state

    let cancelled = false;
    setIsVerifying(true);
    (async () => {
      try {
        const verify = await api.verifyOrderPayment(oid, pid ?? undefined);
        if (!cancelled && verify.success && verify.data?.paymentStatus === 'paid') {
          // The payment actually captured — do NOT offer a retry. Send the
          // customer to the success page (which re-verifies + shows the order).
          const q = new URLSearchParams({ orderId: oid });
          if (pid) q.set('paymentId', pid);
          router.replace(storeUrl(`/checkout/success?${q.toString()}`));
          return; // leave isVerifying true so the error UI never flashes
        }
      } catch {
        // Verification failed (network) — fall through to the error UI. The
        // webhook backstop still reconciles server-side; worst case the
        // customer retries a genuinely-unpaid order, which is correct.
      }
      if (!cancelled) setIsVerifying(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, storeUrl]);

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

  if (isVerifying) {
    return (
      <MinimalChrome>
        <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12">
          <div className="w-full max-w-md text-center">
            <div className="rounded-xl border bg-card p-8 shadow-sm">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-muted border-t-primary" />
              <p className="mt-6 text-muted-foreground">
                {t('Confirming your payment…', 'بنأكد الدفع…')}
              </p>
            </div>
          </div>
        </div>
      </MinimalChrome>
    );
  }

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12">
        <div className="w-full max-w-md text-center">
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/20">
              <svg
                className="h-8 w-8 text-destructive-ink"
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
              {t('Payment could not be processed', 'تعذرت معالجة الدفع')}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {t(
                'Something went wrong during checkout. Please try again or contact support if the problem persists.',
                'حصل خطأ في الدفع. جرّب تاني أو كلّم الدعم لو المشكلة فضلت.'
              )}
            </p>

            <div className="mt-8 flex flex-col gap-3">
              {/* Retry Payment -- redirects back to checkout with orderId/paymentId so the
                checkout page can resume the same order rather than creating a duplicate. */}
              <Button
                className="w-full"
                size="lg"
                onClick={handleRetryPayment}
                isLoading={isRetrying}
              >
                {t('Retry Payment', 'إعادة محاولة الدفع')}
              </Button>

              <Link href={storeUrl('/cart')} className="inline-block">
                <Button className="w-full" size="lg" variant="outline">
                  {t('Return to Cart', 'العودة إلى السلة')}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
