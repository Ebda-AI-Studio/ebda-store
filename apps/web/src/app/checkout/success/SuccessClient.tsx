'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from '../../../components/StoreLink';
import { Button } from '@ebda/ui';
import { api, type Order } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { WaMeCodConfirmButton, useOrderQuestionHref } from '../../../templates/shared/WaMeButtons';
import { useDeliveryWindow } from '../../../components/commerce/DeliveryChip';
import { InstapayCard } from './InstapayCard';
import { FawryReferenceCard } from './FawryReferenceCard';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useCart } from '../../../contexts/CartContext';
import { trackPurchase } from '../../../components/MarketingPixels';
import { firePurchasePixelOnce } from '../../../lib/purchase-pixel-guard';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useLastListing } from '../../../hooks/useLastListing';
import { ReceiptPrinter, type PaymentState } from '../../../components/commerce/ReceiptPrinter';
import { catalogueItemId, fromMinor, REGION } from '@ebda/shared';

// Payment verification outcome that drives the truthful headline/icon.
//   verifying → we're asking the API to confirm with the gateway
//   paid      → provider confirmed PAID
//   pending   → provider hasn't reported a final status yet
//   failed    → provider reported failed/expired/cancelled
//   cod       → cash on delivery (no gateway to verify)
//   awaiting  → InstaPay: the customer transfers, the merchant confirms (no gateway)
//   unknown   → verify couldn't run (no orderId / network) — neutral copy
// (The type lives with ReceiptPrinter, whose status line renders it.)

function SuccessContent() {
  const searchParams = useSearchParams();
  const orderId = searchParams?.get('orderId');
  const isCod = searchParams?.get('cod') === '1';
  const isInstapay = searchParams?.get('instapay') === '1';
  // A Fawry reference code (the customer pays it in cash at an outlet, hours later). A plain
  // code only: anything else in the URL is ignored.
  const rawRef = searchParams?.get('ref') ?? '';
  const fawryRef = /^[A-Za-z0-9-]{4,32}$/.test(rawRef) ? rawRef : null;
  // A gateway may append its payment id to the success URL on return; the
  // casing varies (`paymentId` vs `Id`). Forward it to the API for the
  // audit trail — authorization rides on the order UUID, not this value.
  const returnPaymentId = searchParams?.get('paymentId') || searchParams?.get('Id') || undefined;
  const storeUrl = useStoreUrl();
  const continueShoppingHref = useLastListing();
  const { store } = useStore();
  const { clearCart } = useCart();
  const { t } = useLanguage();

  const [order, setOrder] = useState<Order | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // S-02: the receipt repeats the delivery window of the order's own shipping
  // zone (clock starts at the order's date; the longest made-to-order lead time
  // on the order; no window when the address matches no zone) and offers WhatsApp.
  const orderLead = order
    ? Math.max(0, ...order.items.map(i => i.product?.leadTimeDays ?? 0))
    : null;
  const deliveryWindow = useDeliveryWindow({
    from: order ? new Date(order.createdAt) : null,
    leadTimeDays: orderLead,
    // The ORDER's zone, never the fastest one (W1c review I4).
    address: order ? (order.shippingAddress ?? {}) : null,
  });
  const whatsappHref = useOrderQuestionHref(order?.orderNumber);
  const [paymentState, setPaymentState] = useState<PaymentState>(
    isCod ? 'cod' : isInstapay || fawryRef ? 'awaiting' : 'verifying'
  );

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
      if (!isCod && !isInstapay) {
        try {
          const verify = await api.verifyOrderPayment(orderId!, returnPaymentId);
          if (!cancelled && verify.success && verify.data) {
            const s = verify.data.paymentStatus;
            // An unpaid Fawry reference code is not "being confirmed": it is waiting for the
            // customer to pay it at an outlet.
            setPaymentState(
              s === 'paid' ? 'paid' : s === 'failed' ? 'failed' : fawryRef ? 'awaiting' : 'pending'
            );
          } else if (!cancelled) {
            setPaymentState(fawryRef ? 'awaiting' : 'pending');
          }
        } catch {
          // Verification network error — show pending (truthful: we don't
          // know yet). The webhook backup + the customer's order page will
          // still reflect the real status once it settles.
          if (!cancelled) setPaymentState(fawryRef ? 'awaiting' : 'pending');
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
          // (An InstaPay order is not a sale until the merchant confirms the transfer: paymentStatus stays unpaid.)
          // Once per ORDER, not per mount: a refresh or a re-opened success
          // link must not report the sale again (#1346). The order is marked
          // only when a pixel library actually received it — before marketing
          // consent none is loaded, and the reload after "Accept" must still
          // report the sale.
          if (confirmed) {
            firePurchasePixelOnce(fetchedOrder.id, () =>
              trackPurchase({
                orderId: fetchedOrder.id,
                contentIds: fetchedOrder.items.map(item =>
                  catalogueItemId({ productId: item.productId, variantId: item.variantId })
                ),
                numItems: fetchedOrder.items.reduce((sum, item) => sum + item.quantity, 0),
                value: fromMinor(fetchedOrder.total),
                currency: REGION.currency,
              })
            );
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
    paymentState === 'awaiting' && fawryRef
      ? t('Waiting for your payment', 'بانتظار الدفع')
      : paymentState === 'awaiting'
        ? t('Waiting for your transfer', 'بانتظار التحويل')
        : paymentState === 'failed'
          ? t('Payment not completed', 'الدفع مكملش')
          : paymentState === 'pending'
            ? t('Confirming your payment…', 'بنأكد الدفع…')
            : t('Thank you for your order!', 'شكراً لطلبك!');

  const subCopy =
    paymentState === 'awaiting' && fawryRef
      ? t(
          'Your order is held for you. Pay the reference code below at any Fawry outlet.',
          'طلبك محجوز ليك. ادفع كود الدفع اللي تحت في أي منفذ فوري.'
        )
      : paymentState === 'awaiting'
        ? t(
            'Your order is held for you. Transfer the amount below and the store will confirm it.',
            'طلبك محجوز ليك. حوّل المبلغ اللي تحت والمتجر هيأكده.'
          )
        : paymentState === 'failed'
          ? t(
              'We could not confirm your payment. If you were charged, it will be reconciled shortly — otherwise please try again.',
              'معرفناش نأكد الدفع. لو المبلغ اتخصم هيتسوّى قريب، ولو لأ جرّب تاني.'
            )
          : paymentState === 'pending'
            ? t(
                'Your payment is being confirmed. This page will update, or check your order status shortly.',
                'بنأكد دفعتك. الصفحة دي هتتحدث، أو شوف حالة طلبك بعد شوية.'
              )
            : isCod
              ? t(
                  'Your order has been placed. Please have the payment ready when your order is delivered.',
                  'طلبك اتسجل. جهّز المبلغ لما الطلب يوصلك.'
                )
              : t(
                  'Your payment is confirmed and your order will be shipped soon.',
                  'دفعتك اتأكدت وطلبك هيتشحن قريب.'
                );

  // The receipt printer owns the confirmation moment (Task 10 ruling): while
  // it renders (loading or loaded) the hero icon and the COD banner step aside,
  // since its status line says the same thing. If the order could not be
  // loaded there is no receipt to carry the message, so they come back.
  const showReceipt = order !== null || isLoading;

  return (
    <MinimalChrome>
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8" data-transactional>
        <div className="text-center">
          {/* Status icon \u2014 reflects the VERIFIED payment state, not an
              unconditional checkmark. */}
          {showReceipt ? null : paymentState === 'verifying' ||
            paymentState === 'pending' ||
            paymentState === 'awaiting' ? (
            <div
              data-testid="success-hero-icon"
              className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-warning/15"
            >
              <div className="h-9 w-9 animate-spin rounded-full border-4 border-warning border-t-transparent" />
            </div>
          ) : paymentState === 'failed' ? (
            <div
              data-testid="success-hero-icon"
              className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[hsl(var(--destructive,0_84%_60%))]/15"
            >
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
            <div
              data-testid="success-hero-icon"
              className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success/20"
            >
              <svg
                className="h-10 w-10 text-success-ink"
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

          <h1 className={`${showReceipt ? '' : 'mt-6 '}text-3xl font-bold text-foreground`}>
            {heading}
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">{subCopy}</p>

          {isCod && !showReceipt && (
            <div
              data-testid="success-cod-banner"
              className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3"
            >
              <p className="text-sm font-medium text-warning-ink">
                {t(
                  'Cash on delivery — pay when your order arrives',
                  'الدفع عند الاستلام — ادفع لما طلبك يوصلك'
                )}
              </p>
            </div>
          )}

          {isInstapay && orderId && (
            <InstapayCard
              orderId={orderId}
              onStatus={s =>
                setPaymentState(s === 'awaiting' ? 'awaiting' : s === 'paid' ? 'paid' : 'failed')
              }
            />
          )}

          {fawryRef && <FawryReferenceCard code={fawryRef} />}

          {isCod && order && (
            <WaMeCodConfirmButton order={order} className="mx-auto mt-6 max-w-md" />
          )}

          {showReceipt ? (
            <ReceiptPrinter
              order={order}
              paymentState={paymentState}
              store={store}
              loading={isLoading}
              deliveryWindow={deliveryWindow}
              whatsappHref={whatsappHref}
            />
          ) : (
            <p className="mt-8 text-sm text-muted-foreground">
              {t(
                'Your order has been received. You can track its status anytime from your account.',
                'طلبك وصلنا. تقدر تتابع حالته في أي وقت من حسابك.'
              )}
            </p>
          )}

          <div
            data-success-actions
            className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
          >
            {paymentState === 'failed' && orderId ? (
              <Link href={storeUrl(`/checkout?orderId=${orderId}`)} className="w-full sm:w-64">
                <Button size="lg" className="w-full">
                  {t(
                    'Try payment again',
                    '\u0625\u0639\u0627\u062f\u0629 \u0645\u062d\u0627\u0648\u0644\u0629 \u0627\u0644\u062f\u0641\u0639'
                  )}
                </Button>
              </Link>
            ) : (
              <Link href={continueShoppingHref} className="w-full sm:w-64">
                <Button size="lg" className="w-full">
                  {t(
                    'Continue shopping',
                    '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                  )}
                </Button>
              </Link>
            )}
            <Link href={storeUrl('/account/orders')} className="w-full sm:w-64">
              <Button size="lg" variant="outline" className="w-full">
                {t(
                  'View order status',
                  '\u0639\u0631\u0636 \u062d\u0627\u0644\u0629 \u0627\u0644\u0637\u0644\u0628'
                )}
              </Button>
            </Link>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            {t('Questions about your order?', 'عندك سؤال عن طلبك؟')}{' '}
            <Link
              href={storeUrl('/contact')}
              className="relative text-primary underline underline-offset-4 before:absolute before:-inset-y-4 before:inset-x-0 before:content-['']"
            >
              {t(
                'Contact support',
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
