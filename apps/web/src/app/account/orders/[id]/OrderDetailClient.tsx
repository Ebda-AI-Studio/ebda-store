'use client';

import { VariantText } from '@ebda/ui';
import { MINUS, SignedAmount } from '@/lib/bidi';
import { Sheet } from '@/components/ui/Sheet';
import { useState, useEffect, useCallback } from 'react';
import { useLocalePrice } from '../../../../hooks/useLocalePrice';
import { useNumerals } from '../../../../hooks/useNumerals';
import Link from '../../../../components/StoreLink';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { api, API_URL } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../../contexts/StoreContext';
import { useLanguage } from '../../../../contexts/LanguageContext';
import {
  formatDate as formatStoreDate,
  formatDateTime as formatStoreDateTime,
} from '@/lib/format-date';
import {
  orderAddressLines,
  groupOrderLinesForDisplay,
  orderTaxPlacement,
  storeNumerals,
  intlLocale,
  orderLineVariantTitle,
} from '@ebda/shared';
import {
  orderStatusLabel,
  orderPaymentStatusLabel,
  paymentStatusLabel,
  paymentProviderLabel,
  paymentMethodLabel,
} from '@/lib/order-labels';
import { WaMeOrderQuestionButton } from '../../../../templates/shared/WaMeButtons';
import { CartLineNote } from '../../../../components/commerce/CartLineNote';
import { goldSnapshotLine } from '@/lib/gold-display';
import { ReorderOrderButton } from '../../../../components/commerce/ReorderOrderButton';

interface OrderDetail {
  id: string;
  storeId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  subtotal: number;
  tax: number;
  /** Frozen at sale time (Ruling M3-8): `tax` is already inside subtotal/total. */
  taxIncludedInPrice?: boolean;
  shipping: number;
  /** COD fee frozen at creation, inside `total` (ruling MONEYB-3). */
  codFee?: number;
  discount: number;
  total: number;
  currency: string;
  couponCode?: string;
  couponDiscount: number;
  /** The automatic-promotion portion of `discount` (0 when a coupon — not a
   *  promotion — was the winning lever, or when no discount applied). */
  promotionDiscount?: number;
  /** The promotion that discounted this order, when `promotionDiscount` > 0. */
  appliedPromotion?: { id: string; name: string; nameAr?: string | null } | null;
  /** Loyalty-redemption portion of `discount`, and how many points funded it
   *  (null/0 when no redemption applied). #197. */
  loyaltyDiscount?: number;
  loyaltyPointsRedeemed?: number | null;
  /** Part of `total` paid from the customer wallet (D1), in piastres. */
  walletAmount?: number;
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
    area?: string;
    areaAr?: string;
    governorate?: string;
    governorateAr?: string;
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
    /** Set when this line is a bundle component (Task 6) — see
     *  `groupOrderLinesForDisplay`. Snapshotted at order time; render
     *  as-is, never re-fetch from the (possibly renamed/deleted) bundle. */
    bundleGroupId?: string | null;
    bundleName?: string | null;
    bundleNameAr?: string | null;
    variantName?: string | null;
    /** Arabic variant snapshot (Ruling B0-41), rendered in Arabic with variantName fallback. */
    variantNameAr?: string | null;
    /** The customer's personalisation text for this line. */
    personalisation?: string | null;
    /** Gold-rate line (B5): the shopper-visible subset the server returns (no margin, no rate id). */
    goldSnapshot?: {
      karat: number;
      weightMg: number;
      ratePerGram: number;
    } | null;
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

/** The karat, weight and per-gram rate a gold piece was priced at, frozen on the order (Ruling B5-17). */
function GoldLine({
  item,
}: {
  item: { goldSnapshot?: OrderDetail['items'][number]['goldSnapshot'] };
}) {
  const { language } = useLanguage();
  const money = useLocalePrice();
  const { localize } = useNumerals();
  const line = goldSnapshotLine(
    item.goldSnapshot,
    language === 'ar' ? 'ar' : 'en',
    money,
    localize
  );
  return line ? (
    <p className="text-xs text-muted-foreground" data-testid="order-gold-line">
      {line}
    </p>
  ) : null;
}

export default function OrderDetailClient() {
  const params = useParams();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t, language } = useLanguage();
  const formatPrice = useLocalePrice();
  // Safe cast: this is a standard [id] route (not catch-all [...id]), so
  // params.id is always a single string in Next.js App Router.
  const orderId = params.id as string;

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Controls visibility of the tracking number modal (shown when trackingUrl is absent)
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  // Shopper cancel (Ruling T01-CANCEL-1)
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Order timeline (collapsible, lazy-loaded)
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [timelineRows, setTimelineRows] = useState<
    Array<{
      at: string;
      source: string;
      kind: string;
      fromStatus?: string;
      toStatus?: string;
      details?: string;
      location?: string;
    }>
  >([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineFetched, setTimelineFetched] = useState(false);

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
        setError(result.error.message || t('Failed to load order', 'فشل تحميل الطلب'));
      }
    } catch (err) {
      console.error('Failed to fetch order:', err);
      setError(
        t(
          'Unable to load order details. Please check your connection.',
          'معرفناش نحمّل تفاصيل الطلب. اتأكد من اتصالك بالإنترنت.'
        )
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function cancelThisOrder() {
    if (cancelling) return;
    if (
      !window.confirm(
        t('Cancel this order? This cannot be undone.', 'تلغي الطلب ده؟ مفيش رجوع بعد كده.')
      )
    )
      return;
    setCancelError(null);
    setCancelling(true);
    try {
      const result = await api.cancelOrder(orderId);
      if (result.success) await fetchOrder();
      else
        setCancelError(
          result.error?.message ||
            t('Could not cancel the order. Contact the store.', 'معرفناش نلغي الطلب. كلّم المتجر.')
        );
    } catch {
      setCancelError(
        t(
          'Could not cancel the order. Check your connection and try again.',
          'معرفناش نلغي الطلب. اتأكد من اتصالك وجرّب تاني.'
        )
      );
    } finally {
      setCancelling(false);
    }
  }

  const fetchTimeline = useCallback(async () => {
    if (timelineFetched || !order) return;
    setTimelineLoading(true);
    try {
      const result = await api.getOrderTimeline(order.storeId, order.id);
      if (result.success && result.data) {
        setTimelineRows(result.data.timeline ?? []);
      }
    } catch {
      // non-blocking — timeline is supplementary info
    } finally {
      setTimelineLoading(false);
      setTimelineFetched(true);
    }
  }, [order, timelineFetched]);

  const handleTimelineToggle = useCallback(() => {
    setTimelineExpanded(v => {
      if (!v) fetchTimeline();
      return !v;
    });
  }, [fetchTimeline]);

  // Per-tenant wrappers — render in the store's timezone using the
  // visitor's chosen language. The bare-date version uses the long preset
  // (matches the previous month-day-year visual); the datetime version
  // adds hour + minute.
  function formatDate(date: string) {
    return formatStoreDate(date, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });
  }

  function formatDateTime(date: string) {
    return formatStoreDateTime(date, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
    });
  }

  const orderStatusColors: Record<string, string> = {
    pending: 'bg-warning/20 text-warning-ink',
    confirmed: 'bg-info/20 text-info-ink',
    processing: 'bg-info/20 text-info-ink',
    shipped: 'bg-info/10 text-info-ink',
    delivered: 'bg-success/20 text-success-ink',
    cancelled: 'bg-destructive/20 text-destructive-ink',
    refunded: 'bg-muted text-foreground',
  };

  const paymentStatusColors: Record<string, string> = {
    unpaid: 'bg-warning/20 text-warning-ink',
    paid: 'bg-success/20 text-success-ink',
    partially_paid: 'bg-muted text-foreground',
    refunded: 'bg-muted text-foreground',
    failed: 'bg-destructive/20 text-destructive-ink',
  };

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
              {t('Loading order information...', 'بنحمّل معلومات الطلب...')}
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
              onClick={() => fetchOrder()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30 transition-colors"
            >
              {t('Retry', 'إعادة المحاولة')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!order) return null;

  // Bundle boxes collapse to ONE row each (see groupOrderLinesForDisplay) —
  // a customer must never see the per-component allocated prices that fund
  // that one price. Two boxes of the same bundle render as TWO rows.
  const displayRows = groupOrderLinesForDisplay(order.items);

  const shippingAddr = order.shippingAddress;
  const taxPlacement = orderTaxPlacement(order);
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
              {t('Placed on', 'اتطلب في')} {formatDateTime(order.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${orderStatusColors[order.status] || 'bg-muted text-foreground'}`}
          >
            {orderStatusLabel(order.status, language)}
          </span>
          <span
            className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${paymentStatusColors[order.paymentStatus] || 'bg-muted text-foreground'}`}
          >
            {orderPaymentStatusLabel(order.paymentStatus, language)}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <WaMeOrderQuestionButton orderNumber={order.orderNumber} className="self-start" />
        {/* Ruling T01-CANCEL-1: only a pending, unpaid, cash-on-delivery order; the API enforces the same rule. */}
        {order.status === 'pending' &&
          order.paymentStatus !== 'paid' &&
          order.payments.length > 0 &&
          order.payments.every(p => p.provider === 'cod') && (
            <button
              type="button"
              onClick={cancelThisOrder}
              disabled={cancelling}
              className="self-start rounded-lg border px-4 py-2 text-sm font-medium text-destructive-ink hover:bg-muted disabled:opacity-60"
            >
              {cancelling ? t('Cancelling…', 'بنلغي…') : t('Cancel order', 'إلغاء الطلب')}
            </button>
          )}
        {cancelError && (
          <p role="alert" className="w-full text-sm text-destructive-ink">
            {cancelError}
          </p>
        )}
        {/* Ruling B4-8: only on an order that was paid or delivered (never a cancelled one). */}
        {(order.paymentStatus === 'paid' || order.status === 'delivered') &&
          order.status !== 'cancelled' &&
          order.status !== 'refunded' && <ReorderOrderButton items={order.items} />}
      </div>

      {/* Timeline info */}
      {(order.shippedAt || order.deliveredAt) && (
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap gap-6 text-sm">
            {order.shippedAt && (
              <div>
                <span className="text-muted-foreground">{t('Shipped', 'اتشحن')}:</span>{' '}
                <span className="font-medium text-foreground">{formatDate(order.shippedAt)}</span>
              </div>
            )}
            {order.deliveredAt && (
              <div>
                <span className="text-muted-foreground">{t('Delivered', 'اتسلّم')}:</span>{' '}
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
            {t('Order Items', 'المنتجات')} ({displayRows.length})
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
              {displayRows.map(row => {
                // Bundle boxes collapse to ONE row: name (snapshotted at
                // order time), no per-unit price column (the box has no
                // single "each" price a customer should see), and the
                // group's total. Never render `row.lines` here.
                const name =
                  row.kind === 'bundle'
                    ? language === 'ar' && row.nameAr
                      ? row.nameAr
                      : row.name
                    : row.item.product?.name || 'Product';
                const image = row.kind === 'item' ? row.item.product?.images?.[0]?.url : undefined;
                const quantity = row.kind === 'bundle' ? row.quantity : row.item.quantity;
                const total =
                  row.kind === 'bundle' ? row.total : row.item.price * row.item.quantity;
                return (
                  <tr key={row.key}>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-muted overflow-hidden">
                          {image ? (
                            <Image
                              src={image}
                              alt={name}
                              width={48}
                              height={48}
                              className="h-full w-full object-cover"
                              sizes="48px"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
                        <div>
                          <span className="font-medium text-foreground">
                            {name}
                            {row.kind === 'bundle' && (
                              <span className="ms-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {t('Bundle', 'باقة')}
                              </span>
                            )}
                          </span>
                          {row.kind === 'item' &&
                            orderLineVariantTitle(row.item, language === 'ar') && (
                              <p className="text-xs text-muted-foreground">
                                <VariantText
                                  title={orderLineVariantTitle(row.item, language === 'ar')!}
                                />
                              </p>
                            )}
                          {row.kind === 'item' && <GoldLine item={row.item} />}
                          {row.kind === 'item' && <CartLineNote note={row.item.personalisation} />}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center text-foreground">{quantity}</td>
                    <td className="px-4 py-4 text-right text-foreground">
                      {row.kind === 'bundle' ? '—' : formatPrice(row.item.price)}
                    </td>
                    <td className="px-4 py-4 text-right font-medium text-foreground">
                      {formatPrice(total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile items */}
        <div className="sm:hidden divide-y">
          {displayRows.map(row => {
            const name =
              row.kind === 'bundle'
                ? language === 'ar' && row.nameAr
                  ? row.nameAr
                  : row.name
                : row.item.product?.name || 'Product';
            const image = row.kind === 'item' ? row.item.product?.images?.[0]?.url : undefined;
            const quantity = row.kind === 'bundle' ? row.quantity : row.item.quantity;
            const total = row.kind === 'bundle' ? row.total : row.item.price * row.item.quantity;
            return (
              <div key={row.key} className="flex items-center gap-3 p-4">
                <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-muted overflow-hidden">
                  {image ? (
                    <Image
                      src={image}
                      alt={name}
                      width={56}
                      height={56}
                      className="h-full w-full object-cover"
                      sizes="56px"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
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
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">
                    {name}
                    {row.kind === 'bundle' && (
                      <span className="ms-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {t('Bundle', 'باقة')}
                      </span>
                    )}
                  </p>
                  {row.kind === 'item' && orderLineVariantTitle(row.item, language === 'ar') && (
                    <p className="text-xs text-muted-foreground">
                      <VariantText title={orderLineVariantTitle(row.item, language === 'ar')!} />
                    </p>
                  )}
                  {row.kind === 'item' && <GoldLine item={row.item} />}
                  {row.kind === 'item' && <CartLineNote note={row.item.personalisation} />}
                  <p className="text-sm text-muted-foreground">
                    {row.kind === 'bundle'
                      ? `${t('Qty', 'الكمية')}: ${quantity}`
                      : `${formatPrice(row.item.price)} x ${quantity}`}
                  </p>
                </div>
                <p className="font-medium text-foreground">{formatPrice(total)}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Order Summary & Info Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Order Summary */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="border-b bg-muted px-4 py-3">
            <h2 className="font-semibold text-foreground">{t('Order Summary', 'ملخص الطلب')}</h2>
          </div>
          <div className="p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('Subtotal', 'المجموع الفرعي')}</span>
              <span className="text-foreground">{formatPrice(order.subtotal)}</span>
            </div>
            {(() => {
              // Break the total discount into its levers — coupon, automatic
              // promotion, loyalty-points redemption, and any remainder —
              // instead of an aggregate "Discount" line alongside a
              // coupon-only sub-line, which used to double-count the coupon
              // portion visually. couponDiscount + promotionDiscount +
              // loyaltyDiscount + "other" always reconciles to `discount`
              // (order.service.ts). Loyalty split out (#197) to match the
              // same "Loyalty points" label checkout's OrderSummary.tsx uses
              // — UAT step 11 requires the order detail to show it distinctly,
              // not folded into a generic "Discount" line.
              const couponPortion = order.couponDiscount ?? 0;
              const promotionPortion = order.promotionDiscount ?? 0;
              const loyaltyPortion = order.loyaltyDiscount ?? 0;
              const otherDiscount = Math.max(
                0,
                order.discount - couponPortion - promotionPortion - loyaltyPortion
              );
              const promotionName = order.appliedPromotion
                ? language === 'ar' && order.appliedPromotion.nameAr
                  ? order.appliedPromotion.nameAr
                  : order.appliedPromotion.name
                : null;
              return (
                <>
                  {couponPortion > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {t('Coupon', 'كوبون')}
                        {order.couponCode ? ` (${order.couponCode})` : ''}
                      </span>
                      <span className="text-success-ink">
                        <SignedAmount sign={MINUS} value={formatPrice(couponPortion)} />
                      </span>
                    </div>
                  )}
                  {promotionPortion > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {t('Promotion', 'عرض ترويجي')}
                        {promotionName ? ` (${promotionName})` : ''}
                      </span>
                      <span className="text-success-ink">
                        <SignedAmount sign={MINUS} value={formatPrice(promotionPortion)} />
                      </span>
                    </div>
                  )}
                  {loyaltyPortion > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {t('Loyalty points', 'نقاط الولاء')}
                        {order.loyaltyPointsRedeemed
                          ? ` (${order.loyaltyPointsRedeemed.toLocaleString(
                              intlLocale(language, storeNumerals(store?.theme))
                            )})`
                          : ''}
                      </span>
                      <span className="text-success-ink">
                        <SignedAmount sign={MINUS} value={formatPrice(loyaltyPortion)} />
                      </span>
                    </div>
                  )}
                  {otherDiscount > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{t('Discount', 'الخصم')}</span>
                      <span className="text-success-ink">
                        <SignedAmount sign={MINUS} value={formatPrice(otherDiscount)} />
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
            {/* subtotal → discounts → shipping → COD fee → VAT → total (ruling MONEYB-2). */}
            {order.shipping > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Shipping', 'الشحن')}</span>
                <span className="text-foreground">{formatPrice(order.shipping)}</span>
              </div>
            )}
            {(order.codFee ?? 0) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('Cash on delivery fee', 'رسوم الدفع عند الاستلام')}
                </span>
                <span className="text-foreground">{formatPrice(order.codFee ?? 0)}</span>
              </div>
            )}
            {/* Exclusive tax is a summed row; inclusive tax is already inside
                subtotal/total and renders as a caption after Total instead
                (orderTaxPlacement, issue 2210). */}
            {(taxPlacement.taxRow ?? 0) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('Tax', 'الضريبة')}</span>
                <span className="text-foreground">{formatPrice(taxPlacement.taxRow ?? 0)}</span>
              </div>
            )}
            <div className="border-t pt-3 flex justify-between">
              <span className="font-semibold text-foreground">{t('Total', 'الإجمالي')}</span>
              <span className="font-semibold text-foreground">{formatPrice(order.total)}</span>
            </div>
            {taxPlacement.includedTaxCaption !== null && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t('Incl. VAT', 'شامل ضريبة القيمة المضافة')}</span>
                <span>{formatPrice(taxPlacement.includedTaxCaption)}</span>
              </div>
            )}
            {/* Customer wallet (D1): the part paid from store credit, and the
                rest the customer paid (or pays on delivery). */}
            {(order.walletAmount ?? 0) > 0 && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t('Paid from wallet', 'مدفوع من المحفظة')}
                  </span>
                  <span className="text-success-ink">
                    <SignedAmount sign={MINUS} value={formatPrice(order.walletAmount ?? 0)} />
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground">{t('Amount due', 'المبلغ المستحق')}</span>
                  <span className="text-foreground">
                    {formatPrice(Math.max(0, order.total - (order.walletAmount ?? 0)))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Shipping Address */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
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
            {orderAddressLines(shippingAddr as unknown as Record<string, unknown>, language).map(
              (line, i) => (
                <p key={i}>{line}</p>
              )
            )}
            {shippingAddr.phone && (
              <p className="pt-2 text-muted-foreground">
                {t('Phone', 'رقم الموبايل')}: {shippingAddr.phone}
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
                        {paymentProviderLabel(payment.provider, language)}
                      </span>
                      {payment.method && (
                        <span className="text-muted-foreground">
                          ({paymentMethodLabel(payment.method, language)})
                        </span>
                      )}
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          payment.status === 'completed' || payment.status === 'paid'
                            ? 'bg-success/20 text-success-ink'
                            : payment.status === 'pending'
                              ? 'bg-warning/20 text-warning-ink'
                              : 'bg-destructive/20 text-destructive-ink'
                        }`}
                      >
                        {paymentStatusLabel(payment.status, language)}
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
                        {t('Paid on', 'اتدفع في')} {formatDateTime(payment.paidAt)}
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
          className="rounded-lg border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t('Back to Orders', 'العودة للطلبات')}
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
                    ? 'bg-info text-white hover:bg-info/90 cursor-pointer'
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
                <span className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-1 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100 hidden sm:block">
                  {t('Available when shipped', 'متاح عند الشحن')}
                </span>
              )}
            </div>
          );
        })()}

        {successfulPayment && (
          <button
            type="button"
            onClick={async () => {
              // Admin's /stores/:storeId/orders/:id/invoice route requires
              // store_admin/super_admin and rejects browser navigations (no
              // auth header). The storefront has a customer-scoped route at
              // /public/orders/:id/invoice that authenticates via cookie OR
              // Bearer token and verifies order ownership. Fetch as text,
              // surface the html in a new tab via blob URL — gives the
              // customer the same printable invoice without the 401.
              try {
                const headers: Record<string, string> = {};
                if (typeof window !== 'undefined') {
                  const token = localStorage.getItem('accessToken');
                  if (token) headers.Authorization = `Bearer ${token}`;
                }
                const res = await fetch(`${API_URL}/public/orders/${order.id}/invoice`, {
                  credentials: 'include',
                  headers,
                });
                if (!res.ok) {
                  alert(
                    t(
                      'Could not load invoice. Please log in again and retry.',
                      'معرفناش نحمّل الفاتورة. سجّل دخول تاني وجرّب كمان مرة.'
                    )
                  );
                  return;
                }
                const html = await res.text();
                const blob = new Blob([html], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank', 'noopener,noreferrer');
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
              } catch {
                alert(
                  t(
                    'Could not load invoice. Please try again.',
                    'معرفناش نحمّل الفاتورة. جرّب تاني.'
                  )
                );
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
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
          </button>
        )}
      </div>

      {/* Order Timeline (collapsible, lazy-loaded) */}
      <div className="mt-6 rounded-2xl border border-border bg-card">
        <button
          type="button"
          onClick={handleTimelineToggle}
          className="flex w-full items-center justify-between p-5 text-start"
          aria-expanded={timelineExpanded}
        >
          <span className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            {t('Order Timeline', 'مسار الطلب')}
          </span>
          <svg
            className={`h-4 w-4 text-muted-foreground transition-transform ${timelineExpanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {timelineExpanded && (
          <div className="border-t border-border px-5 pb-5 pt-4">
            {timelineLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            )}
            {!timelineLoading && timelineRows.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t('No timeline events yet', 'مفيش أحداث لسه')}
              </p>
            )}
            {!timelineLoading && timelineRows.length > 0 && (
              <ol className="space-y-0">
                {timelineRows.map((row, idx) => (
                  <li key={`${row.at}-${idx}`} className="relative flex gap-3 pb-5 last:pb-0">
                    {idx < timelineRows.length - 1 && (
                      <span
                        className="absolute start-3.5 top-7 h-[calc(100%-1.75rem)] w-px bg-border"
                        aria-hidden
                      />
                    )}
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </span>
                    <div className="flex-1 min-w-0 pt-1">
                      <p className="text-sm font-medium text-foreground">
                        {row.kind.replace(/[._]/g, ' ')}
                      </p>
                      {row.fromStatus && row.toStatus && (
                        <p className="text-xs text-muted-foreground">
                          {row.fromStatus} → {row.toStatus}
                        </p>
                      )}
                      {row.details && (
                        <p className="text-xs text-muted-foreground">{row.details}</p>
                      )}
                      {row.location && (
                        <p className="text-xs text-muted-foreground">{row.location}</p>
                      )}
                      <time
                        dateTime={row.at}
                        className="mt-0.5 block text-xs text-muted-foreground"
                      >
                        {new Date(row.at).toLocaleString(
                          intlLocale(language, storeNumerals(store?.theme)),
                          {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }
                        )}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* Tracking number panel (no trackingUrl) on the shared Sheet primitive (R-04). */}
      <Sheet
        open={showTrackingModal && !!order.trackingNumber}
        onClose={() => setShowTrackingModal(false)}
        side="center"
        title={t('Tracking Information', 'معلومات التتبع')}
        closeLabel={t('Close', 'إغلاق')}
        className="max-w-sm bg-card text-foreground"
        headerClassName="!pt-4"
        titleClassName="text-lg font-semibold text-foreground"
        bodyClassName="px-6 pb-6"
      >
        <p className="text-sm text-muted-foreground mb-4">
          {t(
            "Use the tracking number below on your carrier's website to check your shipment status.",
            'استخدم رقم التتبع اللي تحت على موقع شركة الشحن عشان تتابع شحنتك.'
          )}
        </p>

        <div className="rounded-lg border border-border bg-muted p-3 flex items-center justify-between gap-3">
          <span className="font-mono text-foreground break-all">{order.trackingNumber}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(order.trackingNumber!).catch(() => undefined);
            }}
            title={t('Copy to clipboard', 'نسخ')}
            aria-label={t('Copy tracking number', 'نسخ رقم التتبع')}
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
          className="mt-4 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {t('Close', 'إغلاق')}
        </button>
      </Sheet>
    </div>
  );
}
