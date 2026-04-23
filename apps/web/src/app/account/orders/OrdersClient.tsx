'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { api, type Order } from '@/lib/api';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';

export default function OrdersClient() {
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  async function fetchOrders() {
    setError(null);
    setIsLoading(true);
    try {
      const result = await api.getOrders();
      if (result.success && result.data) {
        setOrders(result.data.orders);
      } else if (result.error) {
        setError(result.error.message || 'Failed to load orders');
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
      setError('Unable to load orders. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]',
    processing: 'bg-[hsl(var(--info))]/20 text-[hsl(var(--info))]',
    shipped: 'bg-info/10 text-info',
    delivered: 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]',
    cancelled: 'bg-destructive/20 text-destructive',
  };

  const statusLabels: Record<string, [string, string]> = {
    pending: ['Pending', '\u0642\u064a\u062f \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631'],
    processing: [
      'Processing',
      '\u0642\u064a\u062f \u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629',
    ],
    shipped: ['Shipped', '\u062a\u0645 \u0627\u0644\u0634\u062d\u0646'],
    delivered: ['Delivered', '\u062a\u0645 \u0627\u0644\u062a\u0648\u0635\u064a\u0644'],
    cancelled: ['Cancelled', '\u0645\u0644\u063a\u064a'],
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Order History', '\u0633\u062c\u0644 \u0627\u0644\u0637\u0644\u0628\u0627\u062a')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t(
              'View and track your orders',
              '\u0639\u0631\u0636 \u0648\u062a\u062a\u0628\u0639 \u0637\u0644\u0628\u0627\u062a\u0643'
            )}
          </p>
        </div>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('Order History', '\u0633\u062c\u0644 \u0627\u0644\u0637\u0644\u0628\u0627\u062a')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t(
            'View and track your orders',
            '\u0639\u0631\u0636 \u0648\u062a\u062a\u0628\u0639 \u0637\u0644\u0628\u0627\u062a\u0643'
          )}
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-destructive flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-destructive flex-1">{error}</p>
            <button
              onClick={() => fetchOrders()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive rounded hover:bg-destructive/30 transition-colors"
            >
              {t(
                'Retry',
                '\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
              )}
            </button>
          </div>
        </div>
      )}

      {!error && orders.length > 0 ? (
        <div className="space-y-4">
          {orders.map(order => (
            <div key={order.id} className="rounded-xl border bg-card shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b bg-muted p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {t('Order Number', '\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628')}
                    </p>
                    <p className="font-medium text-foreground">#{order.orderNumber}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {t('Date', '\u0627\u0644\u062a\u0627\u0631\u064a\u062e')}
                    </p>
                    <p className="font-medium text-foreground">{formatDate(order.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">
                      {t('Total', '\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a')}
                    </p>
                    <p className="font-medium text-foreground">{formatPrice(order.total)}</p>
                  </div>
                </div>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusColors[order.status] || 'bg-muted text-foreground'}`}
                >
                  {statusLabels[order.status]
                    ? t(statusLabels[order.status][0], statusLabels[order.status][1])
                    : order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                </span>
              </div>

              <div className="p-4">
                {order.items && order.items.length > 0 ? (
                  <div className="space-y-4">
                    {order.items.map(item => (
                      <div key={item.id} className="flex items-center gap-4">
                        <div className="h-16 w-16 flex-shrink-0 rounded-lg bg-muted">
                          {item.product?.images?.[0]?.url ? (
                            <Image
                              src={item.product.images[0].url}
                              alt={item.product?.name || 'Product'}
                              width={64}
                              height={64}
                              className="h-full w-full rounded-lg object-cover"
                              sizes="64px"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-muted-foreground/70">
                              <svg
                                className="h-6 w-6"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={1}
                                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                />
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-foreground">
                            {item.product?.name || 'Product'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {t('Qty', '\u0627\u0644\u0643\u0645\u064a\u0629')}: {item.quantity}
                          </p>
                        </div>
                        <p className="font-medium text-foreground">{formatPrice(item.price)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'No items in this order',
                      '\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0646\u062a\u062c\u0627\u062a \u0641\u064a \u0647\u0630\u0627 \u0627\u0644\u0637\u0644\u0628'
                    )}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t bg-muted p-4">
                {order.status === 'shipped' || order.status === 'delivered' ? (
                  <button
                    className="rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
                    title="Tracking info not available yet"
                    disabled
                  >
                    {t('Track Order', '\u062a\u062a\u0628\u0639 \u0627\u0644\u0637\u0644\u0628')}
                  </button>
                ) : null}
                <Link
                  href={storeUrl(`/account/orders/${order.id}`)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
                >
                  {t(
                    'View Details',
                    '\u0639\u0631\u0636 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644'
                  )}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : !error ? (
        <div className="rounded-xl border bg-card p-12 text-center shadow-sm">
          <svg
            className="mx-auto h-12 w-12 text-muted-foreground/70"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {t(
              'No orders yet',
              '\u0644\u0627 \u062a\u0648\u062c\u062f \u0637\u0644\u0628\u0627\u062a \u0628\u0639\u062f'
            )}
          </h3>
          <p className="mt-2 text-muted-foreground">
            {t(
              'When you place orders, they will appear here.',
              '\u0639\u0646\u062f\u0645\u0627 \u062a\u0642\u0648\u0645 \u0628\u0637\u0644\u0628\u0627\u062a\u060c \u0633\u062a\u0638\u0647\u0631 \u0647\u0646\u0627.'
            )}
          </p>
          <Link
            href={storeUrl('/products')}
            className="mt-6 inline-flex items-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90"
          >
            {t('Start Shopping', '\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u0633\u0648\u0642')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
