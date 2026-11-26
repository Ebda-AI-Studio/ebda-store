'use client';

import { useState, useEffect } from 'react';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import Link from '../../../components/StoreLink';
import Image from 'next/image';
import { api, type Order } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useAuth } from '../../../contexts/AuthContext';
import { formatDate as formatStoreDate } from '@/lib/format-date';
import { groupOrderLinesForDisplay, storeNumerals } from '@ebda/shared';
import { orderStatusLabel } from '@/lib/order-labels';

export default function OrdersClient() {
  const storeUrl = useStoreUrl();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { store } = useStore();
  const { t, language } = useLanguage();
  const formatPrice = useLocalePrice();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // STORE-QA-43: no authed call for a guest (the account layout sends them to sign-in).
    if (authLoading || !isAuthenticated) return;
    fetchOrders();
  }, [authLoading, isAuthenticated]);

  async function fetchOrders() {
    setError(null);
    setIsLoading(true);
    try {
      const result = await api.getOrders();
      if (result.success && result.data) {
        setOrders(result.data.orders);
      } else if (result.error) {
        setError(result.error.message || t('Failed to load orders', 'فشل تحميل الطلبات'));
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
      setError(
        t(
          'Unable to load orders. Please check your connection.',
          'معرفناش نحمّل الطلبات. اتأكد من اتصالك بالإنترنت.'
        )
      );
    } finally {
      setIsLoading(false);
    }
  }

  // Per-tenant wrapper. Renders dates in the store's timezone using the
  // visitor's chosen language so an order placed at 23:30 UTC from a
  // Egypt store displays as the next day Africa/Cairo, not the visitor's
  // home timezone.
  function formatDate(date: string) {
    return formatStoreDate(date, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-warning/20 text-warning-ink',
    processing: 'bg-info/20 text-info-ink',
    shipped: 'bg-info/10 text-info-ink',
    delivered: 'bg-success/20 text-success-ink',
    cancelled: 'bg-destructive/20 text-destructive-ink',
    awaiting_payment_confirmation: 'bg-warning/20 text-warning-ink',
    confirmed: 'bg-info/20 text-info-ink',
    refunded: 'bg-muted text-foreground',
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Order History', 'سجل الطلبات')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t('View and track your orders', 'عرض وتتبع طلباتك')}
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
        <h1 className="text-2xl font-bold text-foreground">{t('Order History', 'سجل الطلبات')}</h1>
        <p className="mt-1 text-muted-foreground">
          {t('View and track your orders', 'عرض وتتبع طلباتك')}
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-destructive-ink flex-shrink-0"
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
            <p className="text-destructive-ink flex-1">{error}</p>
            <button
              onClick={() => fetchOrders()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30 transition-colors"
            >
              {t('Retry', 'إعادة المحاولة')}
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
                      {t('Order Number', 'رقم الطلب')}
                    </p>
                    <p className="font-medium text-foreground">#{order.orderNumber}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('Date', 'التاريخ')}</p>
                    <p className="font-medium text-foreground">{formatDate(order.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t('Total', 'الإجمالي')}</p>
                    <p className="font-medium text-foreground">{formatPrice(order.total)}</p>
                  </div>
                </div>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusColors[order.status] || 'bg-muted text-foreground'}`}
                >
                  {orderStatusLabel(order.status, language)}
                </span>
              </div>

              <div className="p-4">
                {order.items && order.items.length > 0 ? (
                  <div className="space-y-4">
                    {groupOrderLinesForDisplay(order.items).map(row => {
                      // Bundle boxes collapse to ONE row (see
                      // groupOrderLinesForDisplay) — never the per-component
                      // allocated prices that fund the box's one price.
                      const name =
                        row.kind === 'bundle'
                          ? language === 'ar' && row.nameAr
                            ? row.nameAr
                            : row.name
                          : row.item.product?.name || 'Product';
                      const image =
                        row.kind === 'item' ? row.item.product?.images?.[0]?.url : undefined;
                      const quantity = row.kind === 'bundle' ? row.quantity : row.item.quantity;
                      const price = row.kind === 'bundle' ? row.total : row.item.price;
                      return (
                        <div key={row.key} className="flex items-center gap-4">
                          <div className="h-16 w-16 flex-shrink-0 rounded-lg bg-muted">
                            {image ? (
                              <Image
                                src={image}
                                alt={name}
                                width={64}
                                height={64}
                                className="h-full w-full rounded-lg object-cover"
                                sizes="64px"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
                              {name}
                              {row.kind === 'bundle' && (
                                <span className="ms-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                  {t('Bundle', 'باقة')}
                                </span>
                              )}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {t('Qty', 'الكمية')}: {quantity}
                            </p>
                          </div>
                          <p className="font-medium text-foreground">{formatPrice(price)}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('No items in this order', 'مفيش منتجات في الطلب ده')}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t bg-muted p-4">
                {/* Tracking lives on the detail page (carrier link or tracking
                    number), so this opens it instead of being a dead button. */}
                {order.status === 'shipped' || order.status === 'delivered' ? (
                  <Link
                    href={storeUrl(`/account/orders/${order.id}`)}
                    className="rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    {t('Track Order', 'تتبع الطلب')}
                  </Link>
                ) : null}
                <Link
                  href={storeUrl(`/account/orders/${order.id}`)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('View Details', 'عرض التفاصيل')}
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : !error ? (
        <div className="rounded-xl border bg-card p-12 text-center shadow-sm">
          <svg
            className="mx-auto h-12 w-12 text-muted-foreground"
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
            {t('No orders yet', 'مفيش طلبات لسه')}
          </h3>
          <p className="mt-2 text-muted-foreground">
            {t('When you place orders, they will appear here.', 'لما تطلب، طلباتك هتظهر هنا.')}
          </p>
          <Link
            href={storeUrl('/products')}
            className="mt-6 inline-flex items-center rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('Start Shopping', 'ابدأ التسوق')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
