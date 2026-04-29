'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { api, API_URL } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../../contexts/StoreContext';
import { useLanguage } from '../../../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';
import {
  formatDate as formatStoreDate,
  formatDateTime as formatStoreDateTime,
} from '@/lib/format-date';

interface OrderDetail {
  id: string;
  storeId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
  couponCode?: string;
  couponDiscount: number;
  notes?: string;
  customerNotes?: string;
  /** Carrier tracking number, populated when the order is shipped */
  trackingNumber?: string;
  /** Full tracking URL from the carrier, if available */
  trackingUrl?: string;
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    company?: string;
    address1?: string;
    address2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
  };
  billingAddress?: {
    firstName?: string;
    lastName?: string;
    address1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  shippedAt?: string;
  deliveredAt?: string;
  createdAt: string;
  items: {
    id: string;
    productId: string;
    quantity: number;
    price: number;
    product?: {
      name: string;
      images: Array<{ id: string; url: string; alt?: string }>;
    };
  }[];
  payments: {
    id: string;
    provider: string;
    method?: string;
    status: string;
    amount: number;
    transactionId?: string;
    invoiceId?: string;
    paidAt?: string;
  }[];
  customer?: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

export default function OrderDetailClient() {
  const params = useParams();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t, language } = useLanguage();
  // Safe cast: this is a standard [id] route (not catch-all [...id]), so
  // params.id is always a single string in Next.js App Router.
  const orderId = params.id as string;

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Controls visibility of the tracking number modal (shown when trackingUrl is absent)
  const [showTrackingModal, setShowTrackingModal] = useState(false);

  useEffect(() => {
    if (orderId) {
      fetchOrder();
    }
  }, [orderId]);

  async function fetchOrder() {
    setError(null);
    setIsLoading(true);
    try {
      const result = await api.getOrder(orderId);
      if (result.success && result.data) {
        setOrder(result.data.order as unknown as OrderDetail);
      } else if (result.error) {
        setError(result.error.message || 'Failed to load order');
      }
    } catch (err) {
      console.error('Failed to fetch order:', err);
      setError('Unable to load order details. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }

  // Per-tenant wrappers — render in the store's timezone using the
  // visitor's chosen language. The bare-date version uses the long preset
  // (matches the previous month-day-year visual); the datetime version
  // adds hour + minute.
  function formatDate(date: string) {
    return formatStoreDate(date, {
      timezone: store.timezone,
      language,
      style: 'long',
    });
  }

  function formatDateTime(date: string) {
    return formatStoreDateTime(date, {
      timezone: store.timezone,
      language,
    });
  }

  const orderStatusColors: Record<string, string> = {
    pending: 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]',
    confirmed: 'bg-[hsl(var(--info))]/20 text-[hsl(var(--info))]',
    processing: 'bg-[hsl(var(--info))]/20 text-[hsl(var(--info))]',
    shipped: 'bg-info/10 text-info',
    delivered: 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]',
    cancelled: 'bg-destructive/20 text-destructive',
    refunded: 'bg-muted text-foreground',
  };

  const paymentStatusColors: Record<string, string> = {
    unpaid: 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]',
    paid: 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]',
    partially_paid: 'bg-orange-100 text-orange-800',
    refunded: 'bg-muted text-foreground',
    failed: 'bg-destructive/20 text-destructive',
  };

  function formatLabel(value: string) {
    return value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href={storeUrl('/account/orders')}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t(
                'Order Details',
                '\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0637\u0644\u0628'
              )}
            </h1>
            <p className="mt-1 text-muted-foreground">
              {t(
                'Loading order information...',
                '\u062c\u0627\u0631\u064a \u062a\u062d\u0645\u064a\u0644 \u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0637\u0644\u0628...'
              )}
            </p>
          </div>
        </div>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href={storeUrl('/account/orders')}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t(
                'Order Details',
                '\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0637\u0644\u0628'
              )}
            </h1>
          </div>
        </div>
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
              onClick={() => fetchOrder()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive rounded hover:bg-destructive/30 transition-colors"
            >
              {t(
                'Retry',
                '\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!order) return null;

  const shippingAddr = order.shippingAddress;
  const successfulPayment = order.payments?.find(
    p => p.status === 'completed' || p.status === 'paid'
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href={storeUrl('/account/orders')}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('Order', '\u0637\u0644\u0628')} #{order.orderNumber}
            </h1>
            <p className="mt-1 text-muted-foreground">
              {t('Placed on', '\u062a\u0645 \u0627\u0644\u0637\u0644\u0628 \u0641\u064a')}{' '}
              {formatDateTime(order.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${orderStatusColors[order.status] || 'bg-muted text-foreground'}`}
          >
            {formatLabel(order.status)}
          </span>
          <span
            className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${paymentStatusColors[order.paymentStatus] || 'bg-muted text-foreground'}`}
          >
            {formatLabel(order.paymentStatus)}
          </span>
        </div>
      </div>

      {/* Timeline info */}
      {(order.shippedAt || order.deliveredAt) && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap gap-6 text-sm">
            {order.shippedAt && (
              <div>
                <span className="text-muted-foreground">
                  {t('Shipped', '\u062a\u0645 \u0627\u0644\u0634\u062d\u0646')}:
                </span>{' '}
                <span className="font-medium text-foreground">{formatDate(order.shippedAt)}</span>
              </div>
            )}
            {order.deliveredAt && (
              <div>
                <span className="text-muted-foreground">
                  {t('Delivered', '\u062a\u0645 \u0627\u0644\u062a\u0648\u0635\u064a\u0644')}:
                </span>{' '}
                <span className="font-medium text-foreground">{formatDate(order.deliveredAt)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Order Items */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="border-b bg-muted px-4 py-3">
          <h2 className="font-semibold text-foreground">
            {t('Order Items', '\u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a')} (
            {order.items.length})
          </h2>
        </div>

        {/* Desktop table */}
        <div className="hidden sm:block">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">
                  {t('Product', '\u0627\u0644\u0645\u0646\u062a\u062c')}
                </th>
                <th className="px-4 py-3 font-medium text-center">
                  {t('Qty', '\u0627\u0644\u0643\u0645\u064a\u0629')}
                </th>
                <th className="px-4 py-3 font-medium text-right">
                  {t('Price', '\u0627\u0644\u0633\u0639\u0631')}
                </th>
                <th className="px-4 py-3 font-medium text-right">
                  {t('Total', '\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {order.items.map(item => (
                <tr key={item.id}>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-muted overflow-hidden">
                        {item.product?.images?.[0]?.url ? (
                          <Image
                            src={item.product.images[0].url}
                            alt={item.product?.name || 'Product'}
                            width={48}
                            height={48}
                            className="h-full w-full object-cover"
                            sizes="48px"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-muted-foreground/70">
                            <svg
                              className="h-5 w-5"
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
                      <span className="font-medium text-foreground">
                        {item.product?.name || 'Product'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-center text-foreground">{item.quantity}</td>
                  <td className="px-4 py-4 text-right text-foreground">
                    {formatPrice(item.price)}
                  </td>
                  <td className="px-4 py-4 text-right font-medium text-foreground">
                    {formatPrice(item.price * item.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile items */}
        <div className="sm:hidden divide-y">
          {order.items.map(item => (
            <div key={item.id} className="flex items-center gap-3 p-4">
              <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-muted overflow-hidden">
                {item.product?.images?.[0]?.url ? (
                  <Image
                    src={item.product.images[0].url}
                    alt={item.product?.name || 'Product'}
                    width={56}
                    height={56}
                    className="h-full w-full object-cover"
                    sizes="56px"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground/70">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground truncate">
                  {item.product?.name || 'Product'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatPrice(item.price)} x {item.quantity}
                </p>
              </div>
              <p className="font-medium text-foreground">
                {formatPrice(item.price * item.quantity)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Order Summary & Info Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Order Summary */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t('Order Summary', '\u0645\u0644\u062e\u0635 \u0627\u0644\u0637\u0644\u0628')}
            </h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {t(
                  'Subtotal',
                  '\u0627\u0644\u0645\u062c\u0645\u0648\u0639 \u0627\u0644\u0641\u0631\u0639\u064a'
                )}
              </span>
              <span className="text-foreground">{formatPrice(order.subtotal)}</span>
            </div>
            {order.tax > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Tax', '\u0627\u0644\u0636\u0631\u064a\u0628\u0629')}
                </span>
                <span className="text-foreground">{formatPrice(order.tax)}</span>
              </div>
            )}
            {order.shipping > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Shipping', '\u0627\u0644\u0634\u062d\u0646')}
                </span>
                <span className="text-foreground">{formatPrice(order.shipping)}</span>
              </div>
            )}
            {order.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Discount', '\u0627\u0644\u062e\u0635\u0645')}
                </span>
                <span className="text-[hsl(var(--success))]">-{formatPrice(order.discount)}</span>
              </div>
            )}
            {order.couponCode && order.couponDiscount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Coupon', '\u0643\u0648\u0628\u0648\u0646')} ({order.couponCode})
                </span>
                <span className="text-[hsl(var(--success))]">
                  -{formatPrice(order.couponDiscount)}
                </span>
              </div>
            )}
            <div className="border-t pt-3 flex justify-between">
              <span className="font-semibold text-foreground">
                {t('Total', '\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a')}
              </span>
              <span className="font-semibold text-foreground">{formatPrice(order.total)}</span>
            </div>
          </div>
        </div>

        {/* Shipping Address */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t(
                'Shipping Address',
                '\u0639\u0646\u0648\u0627\u0646 \u0627\u0644\u0634\u062d\u0646'
              )}
            </h2>
          </div>
          <div className="p-4 text-sm text-foreground space-y-1">
            {(shippingAddr.firstName || shippingAddr.lastName) && (
              <p className="font-medium text-foreground">
                {[shippingAddr.firstName, shippingAddr.lastName].filter(Boolean).join(' ')}
              </p>
            )}
            {shippingAddr.company && <p>{shippingAddr.company}</p>}
            {shippingAddr.address1 && <p>{shippingAddr.address1}</p>}
            {shippingAddr.address2 && <p>{shippingAddr.address2}</p>}
            {(shippingAddr.city || shippingAddr.state || shippingAddr.postalCode) && (
              <p>
                {[shippingAddr.city, shippingAddr.state, shippingAddr.postalCode]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            )}
            {shippingAddr.country && <p>{shippingAddr.country}</p>}
            {shippingAddr.phone && (
              <p className="pt-2 text-muted-foreground">
                {t('Phone', '\u0627\u0644\u0647\u0627\u062a\u0641')}: {shippingAddr.phone}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Payment Information */}
      {order.payments && order.payments.length > 0 && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t(
                'Payment Information',
                '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u062f\u0641\u0639'
              )}
            </h2>
          </div>
          <div className="p-4">
            <div className="space-y-4">
              {order.payments.map(payment => (
                <div
                  key={payment.id}
                  className="flex flex-wrap items-start justify-between gap-4 text-sm"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {formatLabel(payment.provider)}
                      </span>
                      {payment.method && (
                        <span className="text-muted-foreground">
                          ({formatLabel(payment.method)})
                        </span>
                      )}
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          payment.status === 'completed' || payment.status === 'paid'
                            ? 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]'
                            : payment.status === 'pending'
                              ? 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]'
                              : 'bg-destructive/20 text-destructive'
                        }`}
                      >
                        {formatLabel(payment.status)}
                      </span>
                    </div>
                    {payment.transactionId && (
                      <p className="text-muted-foreground">
                        {t(
                          'Transaction ID',
                          '\u0631\u0642\u0645 \u0627\u0644\u0645\u0639\u0627\u0645\u0644\u0629'
                        )}
                        : <span className="font-mono text-foreground">{payment.transactionId}</span>
                      </p>
                    )}
                    {payment.invoiceId && (
                      <p className="text-muted-foreground">
                        {t(
                          'Invoice ID',
                          '\u0631\u0642\u0645 \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629'
                        )}
                        : <span className="font-mono text-foreground">{payment.invoiceId}</span>
                      </p>
                    )}
                    {payment.paidAt && (
                      <p className="text-muted-foreground">
                        {t('Paid on', '\u062a\u0645 \u0627\u0644\u062f\u0641\u0639 \u0641\u064a')}{' '}
                        {formatDateTime(payment.paidAt)}
                      </p>
                    )}
                  </div>
                  <span className="font-medium text-foreground">{formatPrice(payment.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Notes */}
      {(order.notes || order.customerNotes) && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t('Notes', '\u0645\u0644\u0627\u062d\u0638\u0627\u062a')}
            </h2>
          </div>
          <div className="p-4 text-sm text-foreground space-y-3">
            {order.customerNotes && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                  {t('Your Notes', '\u0645\u0644\u0627\u062d\u0638\u0627\u062a\u0643')}
                </p>
                <p>{order.customerNotes}</p>
              </div>
            )}
            {order.notes && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                  {t(
                    'Store Notes',
                    '\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u0644\u0645\u062a\u062c\u0631'
                  )}
                </p>
                <p>{order.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={storeUrl('/account/orders')}
          className="rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t(
            'Back to Orders',
            '\u0627\u0644\u0639\u0648\u062f\u0629 \u0644\u0644\u0637\u0644\u0628\u0627\u062a'
          )}
        </Link>

        {/* Track Order button -- enabled only when shipped/delivered AND tracking number exists */}
        {(() => {
          const canTrack =
            (order.status === 'shipped' || order.status === 'delivered') && !!order.trackingNumber;

          function handleTrackOrder() {
            if (!canTrack || !order) return;
            if (order.trackingUrl) {
              window.open(order.trackingUrl, '_blank', 'noopener,noreferrer');
            } else {
              setShowTrackingModal(true);
            }
          }

          return (
            <div className="relative">
              <button
                onClick={handleTrackOrder}
                disabled={!canTrack}
                title={
                  canTrack
                    ? order.trackingUrl
                      ? 'Open tracking page'
                      : 'View tracking number'
                    : 'Tracking available when your order is shipped'
                }
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  canTrack
                    ? 'bg-[hsl(var(--info))] text-white hover:bg-[hsl(var(--info))]/90 cursor-pointer'
                    : 'bg-muted text-muted-foreground/70 cursor-not-allowed'
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                  />
                </svg>
                {t('Track Order', '\u062a\u062a\u0628\u0639 \u0627\u0644\u0637\u0644\u0628')}
              </button>
              {/* Tooltip for disabled state */}
              {!canTrack && (
                <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-1 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 hidden sm:block">
                  {t(
                    'Available when shipped',
                    '\u0645\u062a\u0627\u062d \u0639\u0646\u062f \u0627\u0644\u0634\u062d\u0646'
                  )}
                </span>
              )}
            </div>
          );
        })()}

        {successfulPayment && (
          <a
            href={`${API_URL}/stores/${order.storeId}/orders/${order.id}/invoice`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            {t(
              'Download Invoice',
              '\u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629'
            )}
          </a>
        )}
      </div>

      {/* Tracking Number Modal -- shown when there is no trackingUrl */}
      {showTrackingModal && order.trackingNumber && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tracking-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={e => {
            // Close when clicking the backdrop
            if (e.target === e.currentTarget) setShowTrackingModal(false);
          }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <h2 id="tracking-modal-title" className="text-lg font-semibold text-foreground">
                {t(
                  'Tracking Information',
                  '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u062a\u062a\u0628\u0639'
                )}
              </h2>
              <button
                onClick={() => setShowTrackingModal(false)}
                aria-label="Close"
                className="rounded-lg p-1 text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground transition-colors"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              {t(
                "Use the tracking number below on your carrier's website to check your shipment status.",
                '\u0627\u0633\u062a\u062e\u062f\u0645 \u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639 \u0623\u062f\u0646\u0627\u0647 \u0639\u0644\u0649 \u0645\u0648\u0642\u0639 \u0634\u0631\u0643\u0629 \u0627\u0644\u0634\u062d\u0646 \u0644\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u062d\u0627\u0644\u0629 \u0634\u062d\u0646\u062a\u0643.'
              )}
            </p>

            <div className="rounded-lg border border-border bg-muted p-3 flex items-center justify-between gap-3">
              <span className="font-mono text-foreground break-all">{order.trackingNumber}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(order.trackingNumber!).catch(() => undefined);
                }}
                title="Copy to clipboard"
                className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              </button>
            </div>

            <button
              onClick={() => setShowTrackingModal(false)}
              className="mt-4 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
            >
              {t('Close', '\u0625\u063a\u0644\u0627\u0642')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
