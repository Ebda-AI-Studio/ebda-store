'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@force/ui';
import { api, type Order } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useCart } from '../../../contexts/CartContext';
import { trackPurchase } from '../../../components/MarketingPixels';
import { useLanguage } from '../../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';

function SuccessContent() {
  const searchParams = useSearchParams();
  const orderId = searchParams?.get('orderId');
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { clearCart } = useCart();
  const { t } = useLanguage();

  const [order, setOrder] = useState<Order | null>(null);
  const [, setIsLoading] = useState(true);

  useEffect(() => {
    // Clear cart on successful checkout
    clearCart();
  }, [clearCart]);

  useEffect(() => {
    if (!orderId) {
      setIsLoading(false);
      return;
    }

    async function fetchOrder() {
      try {
        const result = await api.getOrder(orderId!);
        if (result.success && result.data) {
          const fetchedOrder = result.data.order;
          setOrder(fetchedOrder);

          // Fire Purchase pixel event with real order data
          trackPurchase({
            orderId: fetchedOrder.id,
            contentIds: fetchedOrder.items.map(item => item.productId),
            numItems: fetchedOrder.items.reduce((sum, item) => sum + item.quantity, 0),
            value: fetchedOrder.total / 1000,
            currency: 'KWD',
          });
        }
      } catch {
        // Non-critical - page still works without order details
      } finally {
        setIsLoading(false);
      }
    }

    fetchOrder();
  }, [orderId]);

  return (
    <main className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-center px-4 sm:px-6 lg:px-8">
          <Link href={storeUrl('/')} className="flex items-center gap-2">
            {store?.logo ? (
              <Image
                src={store.logo}
                alt={store.name}
                width={40}
                height={30}
                className="object-contain"
              />
            ) : (
              <span className="text-xl font-bold">
                <span className="text-primary">{store?.name || 'Force'}</span>
                <span className="text-foreground"> Store</span>
              </span>
            )}
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          {/* Success Icon */}
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

          <h1 className="mt-6 text-3xl font-bold text-foreground">
            {t(
              'Thank you for your order!',
              '\u0634\u0643\u0631\u0627\u064b \u0644\u0637\u0644\u0628\u0643!'
            )}
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">
            {t(
              'Your order has been confirmed and will be shipped soon.',
              '\u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0637\u0644\u0628\u0643 \u0648\u0633\u064a\u062a\u0645 \u0634\u062d\u0646\u0647 \u0642\u0631\u064a\u0628\u0627\u064b.'
            )}
          </p>

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
                  {order?.createdAt
                    ? new Date(order.createdAt).toLocaleDateString()
                    : new Date().toLocaleDateString()}
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
                    "We'll send you a confirmation email with your order details and tracking information once your order ships.",
                    '\u0633\u0646\u0631\u0633\u0644 \u0644\u0643 \u0628\u0631\u064a\u062f\u0627\u064b \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a\u0627\u064b \u0644\u0644\u062a\u0623\u0643\u064a\u062f \u064a\u062a\u0636\u0645\u0646 \u062a\u0641\u0627\u0635\u064a\u0644 \u0637\u0644\u0628\u0643 \u0648\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u062a\u062a\u0628\u0639 \u0628\u0645\u062c\u0631\u062f \u0634\u062d\u0646 \u0637\u0644\u0628\u0643.'
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
                  {t(
                    'Order confirmation email sent',
                    '\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0628\u0631\u064a\u062f \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0637\u0644\u0628'
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
                  {t(
                    'Order shipped (tracking sent via email)',
                    '\u062a\u0645 \u0634\u062d\u0646 \u0627\u0644\u0637\u0644\u0628 (\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062a\u062a\u0628\u0639 \u0639\u0628\u0631 \u0627\u0644\u0628\u0631\u064a\u062f)'
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
            <Link href={storeUrl('/products')}>
              <Button size="lg">
                {t(
                  'Continue Shopping',
                  '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
                )}
              </Button>
            </Link>
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
    </main>
  );
}

export default function SuccessClient() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500" />
        </main>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}
