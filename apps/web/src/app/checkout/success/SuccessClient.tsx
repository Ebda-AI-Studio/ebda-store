'use client';

import { useState, useEffect, Suspense } from 'react';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { api, type Order } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useCart } from '../../../contexts/CartContext';
import { trackPurchase } from '../../../components/MarketingPixels';
import { useLanguage } from '../../../contexts/LanguageContext';
import { formatDate } from '@/lib/format-date';
import { useLastListing } from '../../../hooks/useLastListing';

// Payment verification outcome that drives the truthful headline/icon.
//   verifying → we're asking the API to confirm with the gateway
//   paid      → provider confirmed PAID
//   pending   → provider hasn't reported a final status yet (KNET delay)
//   failed    → provider reported failed/expired/cancelled
//   cod       → cash on delivery (no gateway to verify)
//   unknown   → verify couldn't run (no orderId / network) — neutral copy
type PaymentState = 'verifying' | 'paid' | 'pending' | 'failed' | 'cod' | 'unknown';

function SuccessContent() {
  const searchParams = useSearchParams();
  const orderId = searchParams?.get('orderId');
  const isCod = searchParams?.get('cod') === '1';
  // MyFatoorah appends its PaymentId to the success URL on return; the
  // casing varies (`paymentId` vs `Id`). Forward it to the API for the
  // audit trail — authorization rides on the order UUID, not this value.
  const returnPaymentId = searchParams?.get('paymentId') || searchParams?.get('Id') || undefined;
  const storeUrl = useStoreUrl();
  const continueShoppingHref = useLastListing();
  const { store } = useStore();
  const { clearCart } = useCart();
  const { t, language } = useLanguage();
  const formatPrice = useLocalePrice();

  const [order, setOrder] = useState<Order | null>(null);
  const [, setIsLoading] = useState(true);
  const [paymentState, setPaymentState] = useState<PaymentState>(isCod ? 'cod' : 'verifying');
  const [pixelFired, setPixelFired] = useState(false);

  useEffect(() => {
    // Clear cart on successful checkout
    clearCart();
  }, [clearCart]);

  useEffect(() => {
    if (!orderId) {
      setIsLoading(false);
      setPaymentState(prev => (prev === 'cod' ? 'cod' : 'unknown'));
      return;
    }

    let cancelled = false;

    async function run() {
      // For online payments, verify-on-return FIRST so the page tells the
      // truth (paid vs pending vs failed) instead of always claiming
      // "confirmed". This is the reliable confirmation path — it also
      // triggers the same server-side fanout (email/push/accounting) the
      // missed webhook would have. Idempotent + safe to call on reload.
      if (!isCod) {
        try {
          const verify = await api.verifyOrderPayment(orderId!, returnPaymentId);
          if (!cancelled && verify.success && verify.data) {
            const s = verify.data.paymentStatus;
            setPaymentState(s === 'paid' ? 'paid' : s === 'failed' ? 'failed' : 'pending');
          } else if (!cancelled) {
            setPaymentState('pending');
          }
        } catch {
          // Verification network error — show pending (truthful: we don't
          // know yet). The webhook backup + the customer's order page will
          // still reflect the real status once it settles.
          if (!cancelled) setPaymentState('pending');
        }
      }

      try {
        const result = await api.getOrder(orderId!);
        if (!cancelled && result.success && result.data) {
          const fetchedOrder = result.data.order;
          setOrder(fetchedOrder);

          // Only fire the Purchase pixel for a CONFIRMED sale — COD orders
          // (committed) or online orders the provider reported paid. Don't
          // attribute revenue for a pending/failed gateway return.
          const confirmed = isCod || fetchedOrder.paymentStatus === 'paid';
          if (confirmed && !pixelFired) {
            setPixelFired(true);
            trackPurchase({
              orderId: fetchedOrder.id,
              contentIds: fetchedOrder.items.map(item => item.productId),
              numItems: fetchedOrder.items.reduce((sum, item) => sum + item.quantity, 0),
              value: fetchedOrder.total / 1000,
              currency: 'KWD',
            });
          }
        }
      } catch {
        // Non-critical - page still works without order details
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Truthful headline + sub-copy per verified state.
  const heading =
    paymentState === 'failed'
      ? t('Payment not completed', 'لم يكتمل الدفع')
      : paymentState === 'pending'
        ? t('Confirming your payment…', 'جاري تأكيد الدفع…')
        : t('Thank you for your order!', 'شكراً لطلبك!');

  const subCopy =
    paymentState === 'failed'
      ? t(
          'We could not confirm your payment. If you were charged, it will be reconciled shortly — otherwise please try again.',
          'لم نتمكن من تأكيد الدفع. إذا تم خصم المبلغ فسيتم تسويته قريباً، وإلا يرجى المحاولة مرة أخرى.'
        )
      : paymentState === 'pending'
        ? t(
            'Your payment is being confirmed. This page will update, or check your order status shortly.',
            'جاري تأكيد دفعتك. ستتحدث هذه الصفحة، أو تحقق من حالة طلبك بعد قليل.'
          )
        : isCod
          ? t(
              'Your order has been placed. Please have the payment ready when your order is delivered.',
              'تم تقديم طلبك. يرجى تجهيز المبلغ عند استلام الطلب.'
            )
          : t(
              'Your payment is confirmed and your order will be shipped soon.',
              'تم تأكيد دفعتك وسيتم شحن طلبك قريباً.'
            );

  return (
    <MinimalChrome>
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          {/* Status icon \u2014 reflects the VERIFIED payment state, not an
              unconditional checkmark. */}
          {paymentState === 'verifying' || paymentState === 'pending' ? (
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[hsl(var(--warning))]/15">
              <div className="h-9 w-9 animate-spin rounded-full border-4 border-[hsl(var(--warning))] border-t-transparent" />
            </div>
          ) : paymentState === 'failed' ? (
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[hsl(var(--destructive,0_84%_60%))]/15">
              <svg
                className="h-10 w-10 text-[hsl(var(--destructive,0_84%_60%))]"
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
          ) : (
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[hsl(var(--success))]/20">
              <svg
                className="h-10 w-10 text-[hsl(var(--success))]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          )}

          <h1 className="mt-6 text-3xl font-bold text-foreground">{heading}</h1>
          <p className="mt-2 text-lg text-muted-foreground">{subCopy}</p>

          {isCod && (
            <div className="mt-4 rounded-lg border border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 px-4 py-3">
              <p className="text-sm font-medium text-[hsl(var(--warning))]">
                {t(
                  'Cash on Delivery — Pay when your order arrives',
                  '\u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645 — \u0627\u062f\u0641\u0639 \u0639\u0646\u062f \u0648\u0635\u0648\u0644 \u0637\u0644\u0628\u0643'
                )}
              </p>
            </div>
          )}

          <div className="mt-8 rounded-xl border bg-card p-6 shadow-sm text-left">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t('Order number', '\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628')}
                </p>
                <p className="text-lg font-semibold text-foreground">
                  {order
                    ? `#${order.orderNumber}`
                    : orderId
                      ? `#${orderId.slice(0, 8)}...`
                      : t(
                          'Processing',
                          '\u062c\u0627\u0631\u064a \u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629'
                        )}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted-foreground">
                  {t('Date', '\u0627\u0644\u062a\u0627\u0631\u064a\u062e')}
                </p>
                <p className="text-foreground">
                  {formatDate(order?.createdAt ?? new Date(), {
                    timezone: store.timezone,
                    language,
                    style: 'short',
                  })}
                </p>
              </div>
            </div>

            {/* Order Items */}
            {order?.items && order.items.length > 0 && (
              <div className="divide-y py-4">
                {order.items.map(item => (
                  <div key={item.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="font-medium text-foreground">
                        {item.product?.name || 'Product'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('Qty', '\u0627\u0644\u0643\u0645\u064a\u0629')}: {item.quantity}
                      </p>
                    </div>
                    <p className="font-medium text-foreground">
                      {formatPrice(item.price * item.quantity)}
                    </p>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-3">
                  <p className="font-semibold text-foreground">
                    {t('Total', '\u0627\u0644\u0645\u062c\u0645\u0648\u0639')}
                  </p>
                  <p className="font-bold text-primary">{formatPrice(order.total)}</p>
                </div>
              </div>
            )}

            {!order?.items && (
              <div className="py-4">
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Your order has been received. You can track its status anytime from your account.',
                    'تم استلام طلبك. يمكنك متابعة حالته في أي وقت من حسابك.'
                  )}
                </p>
              </div>
            )}

            <div className="border-t pt-4">
              <h3 className="font-medium text-foreground">
                {t("What's next?", '\u0645\u0627 \u0627\u0644\u062a\u0627\u0644\u064a\u061f')}
              </h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  {t('Order received', 'تم استلام الطلب')}
                </li>
                <li className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-muted-foreground/70"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {t(
                    'Processing your order',
                    '\u062c\u0627\u0631\u064a \u0645\u0639\u0627\u0644\u062c\u0629 \u0637\u0644\u0628\u0643'
                  )}
                </li>
                <li className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-muted-foreground/70"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                    />
                  </svg>
                  {t('Order shipped', 'تم شحن الطلب')}
                </li>
                <li className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-muted-foreground/70"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                    />
                  </svg>
                  {t(
                    'Delivered to your doorstep',
                    '\u062a\u0645 \u0627\u0644\u062a\u0648\u0635\u064a\u0644 \u0625\u0644\u0649 \u0628\u0627\u0628 \u0645\u0646\u0632\u0644\u0643'
                  )}
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:justify-center">
            {paymentState === 'failed' && orderId ? (
              <Link href={storeUrl(`/checkout?orderId=${orderId}`)}>
                <Button size="lg">
                  {t(
                    'Try payment again',
                    '\u0625\u0639\u0627\u062f\u0629 \u0645\u062d\u0627\u0648\u0644\u0629 \u0627\u0644\u062f\u0641\u0639'
                  )}
                </Button>
              </Link>
            ) : (
              <Link href={continueShoppingHref}>
                <Button size="lg">
                  {t(
                    'Continue Shopping',
                    '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                  )}
                </Button>
              </Link>
            )}
            <Link href={storeUrl('/account/orders')}>
              <Button size="lg" variant="outline">
                {t(
                  'View Order Status',
                  '\u0639\u0631\u0636 \u062d\u0627\u0644\u0629 \u0627\u0644\u0637\u0644\u0628'
                )}
              </Button>
            </Link>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            {t(
              'Questions about your order?',
              '\u0647\u0644 \u0644\u062f\u064a\u0643 \u0623\u0633\u0626\u0644\u0629 \u062d\u0648\u0644 \u0637\u0644\u0628\u0643\u061f'
            )}{' '}
            <Link href={storeUrl('/contact')} className="text-primary hover:underline">
              {t(
                'Contact Support',
                '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u062f\u0639\u0645'
              )}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}

export default function SuccessClient() {
  return (
    <Suspense
      fallback={
        <MinimalChrome>
          <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </MinimalChrome>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}
