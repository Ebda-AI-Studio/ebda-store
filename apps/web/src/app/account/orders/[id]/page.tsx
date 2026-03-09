'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useStoreUrl } from '../../../../contexts/StoreContext';
import { useLanguage } from '../../../../contexts/LanguageContext';

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

export default function OrderDetailPage() {
  const params = useParams();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
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

  function formatDate(date: string) {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function formatDateTime(date: string) {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatPrice(fils: number) {
    return new Intl.NumberFormat('en-KW', {
      style: 'currency',
      currency: 'KWD',
    }).format(fils / 1000);
  }

  const orderStatusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    confirmed: 'bg-blue-100 text-blue-800',
    processing: 'bg-blue-100 text-blue-800',
    shipped: 'bg-purple-100 text-purple-800',
    delivered: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
    refunded: 'bg-muted text-foreground',
  };

  const paymentStatusColors: Record<string, string> = {
    unpaid: 'bg-yellow-100 text-yellow-800',
    paid: 'bg-green-100 text-green-800',
    partially_paid: 'bg-orange-100 text-orange-800',
    refunded: 'bg-muted text-foreground',
    failed: 'bg-red-100 text-red-800',
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
              {t('Order Details', 'تفاصيل الطلب')}
            </h1>
            <p className="mt-1 text-muted-foreground">
              {t('Loading order information...', 'جاري تحميل معلومات الطلب...')}
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
              {t('Order Details', 'تفاصيل الطلب')}
            </h1>
          </div>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-red-500 flex-shrink-0"
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
            <p className="text-red-700 flex-1">{error}</p>
            <button
              onClick={() => fetchOrder()}
              className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
            >
              {t('Retry', 'إعادة المحاولة')}
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
              {t('Order', 'طلب')} #{order.orderNumber}
            </h1>
            <p className="mt-1 text-muted-foreground">
              {t('Placed on', 'تم الطلب في')} {formatDateTime(order.createdAt)}
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
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-6 text-sm">
            {order.shippedAt && (
              <div>
                <span className="text-muted-foreground">{t('Shipped', 'تم الشحن')}:</span>{' '}
                <span className="font-medium text-foreground">{formatDate(order.shippedAt)}</span>
              </div>
            )}
            {order.deliveredAt && (
              <div>
                <span className="text-muted-foreground">{t('Delivered', 'تم التوصيل')}:</span>{' '}
                <span className="font-medium text-foreground">{formatDate(order.deliveredAt)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Order Items */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="border-b bg-muted px-4 py-3">
          <h2 className="font-semibold text-foreground">
            {t('Order Items', 'المنتجات')} ({order.items.length})
          </h2>
        </div>

        {/* Desktop table */}
        <div className="hidden sm:block">
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t('Product', 'المنتج')}</th>
                <th className="px-4 py-3 font-medium text-center">{t('Qty', 'الكمية')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('Price', 'السعر')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('Total', 'الإجمالي')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {order.items.map(item => (
                <tr key={item.id}>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-muted overflow-hidden">
                        {item.product?.images?.[0]?.url ? (
                          <img
                            src={item.product.images[0].url}
                            alt={item.product?.name || 'Product'}
                            className="h-full w-full object-cover"
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
                  <img
                    src={item.product.images[0].url}
                    alt={item.product?.name || 'Product'}
                    className="h-full w-full object-cover"
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
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">{t('Order Summary', 'ملخص الطلب')}</h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('Subtotal', 'المجموع الفرعي')}</span>
              <span className="text-foreground">{formatPrice(order.subtotal)}</span>
            </div>
            {order.tax > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Tax', 'الضريبة')}</span>
                <span className="text-foreground">{formatPrice(order.tax)}</span>
              </div>
            )}
            {order.shipping > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Shipping', 'الشحن')}</span>
                <span className="text-foreground">{formatPrice(order.shipping)}</span>
              </div>
            )}
            {order.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Discount', 'الخصم')}</span>
                <span className="text-green-600">-{formatPrice(order.discount)}</span>
              </div>
            )}
            {order.couponCode && order.couponDiscount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Coupon', 'كوبون')} ({order.couponCode})
                </span>
                <span className="text-green-600">-{formatPrice(order.couponDiscount)}</span>
              </div>
            )}
            <div className="border-t pt-3 flex justify-between">
              <span className="font-semibold text-foreground">{t('Total', 'الإجمالي')}</span>
              <span className="font-semibold text-foreground">{formatPrice(order.total)}</span>
            </div>
          </div>
        </div>

        {/* Shipping Address */}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t('Shipping Address', 'عنوان الشحن')}
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
                {t('Phone', 'الهاتف')}: {shippingAddr.phone}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Payment Information */}
      {order.payments && order.payments.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">
              {t('Payment Information', 'معلومات الدفع')}
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
                            ? 'bg-green-100 text-green-800'
                            : payment.status === 'pending'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {formatLabel(payment.status)}
                      </span>
                    </div>
                    {payment.transactionId && (
                      <p className="text-muted-foreground">
                        {t('Transaction ID', 'رقم المعاملة')}:{' '}
                        <span className="font-mono text-foreground">{payment.transactionId}</span>
                      </p>
                    )}
                    {payment.invoiceId && (
                      <p className="text-muted-foreground">
                        {t('Invoice ID', 'رقم الفاتورة')}:{' '}
                        <span className="font-mono text-foreground">{payment.invoiceId}</span>
                      </p>
                    )}
                    {payment.paidAt && (
                      <p className="text-muted-foreground">
                        {t('Paid on', 'تم الدفع في')} {formatDateTime(payment.paidAt)}
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
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">{t('Notes', 'ملاحظات')}</h2>
          </div>
          <div className="p-4 text-sm text-foreground space-y-3">
            {order.customerNotes && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                  {t('Your Notes', 'ملاحظاتك')}
                </p>
                <p>{order.customerNotes}</p>
              </div>
            )}
            {order.notes && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                  {t('Store Notes', 'ملاحظات المتجر')}
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
          className="rounded-lg border bg-white px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t('Back to Orders', 'العودة للطلبات')}
        </Link>

        {/* Track Order button — enabled only when shipped/delivered AND tracking number exists */}
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
                    ? 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer'
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
                {t('Track Order', 'تتبع الطلب')}
              </button>
              {/* Tooltip for disabled state */}
              {!canTrack && (
                <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 hidden sm:block">
                  {t('Available when shipped', 'متاح عند الشحن')}
                </span>
              )}
            </div>
          );
        })()}

        {successfulPayment && (
          <a
            href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/stores/${order.storeId}/orders/${order.id}/invoice`}
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
            {t('Download Invoice', 'تحميل الفاتورة')}
          </a>
        )}
      </div>

      {/* Tracking Number Modal — shown when there is no trackingUrl */}
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
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <h2 id="tracking-modal-title" className="text-lg font-semibold text-foreground">
                {t('Tracking Information', 'معلومات التتبع')}
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
                'استخدم رقم التتبع أدناه على موقع شركة الشحن للتحقق من حالة شحنتك.'
              )}
            </p>

            <div className="rounded-lg border border-border bg-muted p-3 flex items-center justify-between gap-3">
              <span className="font-mono text-foreground break-all">{order.trackingNumber}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(order.trackingNumber!).catch(() => undefined);
                }}
                title="Copy to clipboard"
                className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-gray-200 hover:text-foreground transition-colors"
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
              {t('Close', 'إغلاق')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
