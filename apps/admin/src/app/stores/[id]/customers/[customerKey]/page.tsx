'use client';

import { Fragment, useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet } from '../../../../../lib/api';

interface CustomerDetail {
  id: string;
  isGuest: boolean;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  address1: string;
  address2: string;
  city: string;
  area: string;
  country: string;
  postalCode: string;
  accountCreatedAt: string | null;
  firstOrderDate: string;
  lastOrderDate: string;
  totalOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  paidCount: number;
  pendingCount: number;
  cancelledCount: number;
  failedCount: number;
  refundedCount: number;
  totalRefunded: number;
  paymentMethods: string[];
  statuses: string[];
}

interface OrderItemRow {
  id: string;
  productName: string;
  quantity: number;
  price: number;
  total: number;
}

interface PaymentRow {
  provider: string;
  status: string;
  amount: number;
  refundedAmount?: number;
  metadata?: {
    refundId?: string;
    refundReason?: string | null;
    refundedAt?: string;
  } | null;
  updatedAt?: string;
}

interface OrderRow {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  paymentStatus: string;
  createdAt: string;
  items: OrderItemRow[];
  payments: PaymentRow[];
}

import { formatDate, formatPrice } from '../../../../../lib/format';
import { useT } from '../../../../../i18n/useT';

function formatKwd(fils: number): string {
  return formatPrice(fils);
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === 'paid' || status === 'completed' || status === 'confirmed'
      ? 'bg-success/10 text-success'
      : status === 'cancelled' || status === 'failed' || status === 'refunded'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-warning/10 text-warning';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

export default function CustomerDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const customerKey = params?.customerKey as string;

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = useT('customers.detail');

  const fetchDetail = useCallback(async () => {
    if (!storeId || !customerKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{
        customer: CustomerDetail;
        orders: OrderRow[];
      }>(`/api/v1/stores/${storeId}/customers/${encodeURIComponent(customerKey)}`);
      if (apiError) {
        setError(apiError.message || t('fetchFailed'));
      } else if (data) {
        setCustomer(data.customer);
        setOrders(data.orders);
      }
    } catch {
      setError(t('fetchFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, customerKey]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const displayName =
    customer && (customer.firstName || customer.lastName)
      ? `${customer.firstName} ${customer.lastName}`.trim()
      : customer?.email || customer?.phone || t('displayFallback');

  return (
    <AdminLayout
      title={displayName}
      subtitle={customer?.isGuest ? t('subtitleGuest') : t('subtitleRegistered')}
      actions={
        <Link href={`/stores/${storeId}/customers`}>
          <Button type="button" variant="outline">
            {t('backToCustomers')}
          </Button>
        </Link>
      }
    >
      {isLoading ? (
        <div className="space-y-4">
          <div className="h-32 animate-pulse rounded-xl bg-muted" />
          <div className="h-48 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : (
        // Always render the error banner when present; then render partial
        // data if customer loaded (e.g. a paginated expansion failed after
        // the first page succeeded). `!customer` stays null-guarded below.
        <>
          {error && (
            <div className="mb-4 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
              <button type="button" className="ms-4 font-medium underline" onClick={fetchDetail}>
                {t('retry')}
              </button>
            </div>
          )}
          {!customer ? null : (
            <div className="space-y-6">
              {/* Identity + address card */}
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-xl border bg-card p-6 shadow-sm">
                  <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('contactSection')}
                  </h2>
                  <dl className="space-y-3 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">{t('fieldName')}</dt>
                      <dd className="font-medium text-foreground text-end">
                        {customer.firstName} {customer.lastName}
                        {customer.isGuest && (
                          <span className="ms-2 inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                            {t('guestBadge')}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">{t('fieldEmail')}</dt>
                      <dd className="font-medium text-foreground text-end" dir="ltr">
                        {customer.email ? (
                          <a href={`mailto:${customer.email}`} className="hover:underline">
                            {customer.email}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">{t('fieldPhone')}</dt>
                      <dd className="font-medium text-foreground text-end" dir="ltr">
                        {customer.phone ? (
                          <a href={`tel:${customer.phone}`} className="hover:underline">
                            {customer.phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">{t('fieldSince')}</dt>
                      <dd className="font-medium text-foreground text-end">
                        {formatDate(customer.accountCreatedAt ?? customer.firstOrderDate)}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-xl border bg-card p-6 shadow-sm">
                  <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('shippingSection')}
                  </h2>
                  {customer.address ? (
                    <div className="space-y-1 text-sm text-foreground">
                      {customer.address1 && <p>{customer.address1}</p>}
                      {customer.address2 && <p>{customer.address2}</p>}
                      {(customer.area || customer.city) && (
                        <p>{[customer.area, customer.city].filter(Boolean).join(', ')}</p>
                      )}
                      {(customer.country || customer.postalCode) && (
                        <p className="text-muted-foreground">
                          {[customer.country, customer.postalCode].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('noShipping')}</p>
                  )}
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsOrders')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{customer.totalOrders}</p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsSpent')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatKwd(customer.totalSpent)}
                  </p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsAvgOrder')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatKwd(customer.avgOrderValue)}
                  </p>
                </div>
                <div className="rounded-xl border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsLastOrder')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatDate(customer.lastOrderDate)}
                  </p>
                </div>
              </div>

              {/* Status breakdown */}
              <div className="flex flex-wrap items-center gap-3">
                {customer.paidCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
                    {t('statusPaid')} · {customer.paidCount}
                  </span>
                )}
                {customer.pendingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1 text-xs font-medium text-warning">
                    {t('statusPending')} · {customer.pendingCount}
                  </span>
                )}
                {customer.cancelledCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive">
                    {t('statusCancelled')} · {customer.cancelledCount}
                  </span>
                )}
                {customer.failedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive">
                    {t('statusFailed')} · {customer.failedCount}
                  </span>
                )}
                {customer.refundedCount > 0 && (
                  <span
                    title={`${t('refunded')}: ${formatKwd(customer.totalRefunded)}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive"
                  >
                    {t('statusRefunded')} · {customer.refundedCount}
                    <span className="text-[10px] text-destructive/70">
                      ({formatKwd(customer.totalRefunded)})
                    </span>
                  </span>
                )}
                {customer.paymentMethods.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('paymentMethods')} {customer.paymentMethods.join(', ')}
                  </span>
                )}
              </div>

              {/* Orders table */}
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <div className="border-b bg-muted/40 px-6 py-3">
                  <h2 className="text-sm font-semibold text-foreground">
                    {t('ordersSection', { count: orders.length })}
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/20">
                      <tr>
                        <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colOrderNum')}
                        </th>
                        <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colDate')}
                        </th>
                        <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colStatus')}
                        </th>
                        <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colPayment')}
                        </th>
                        <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                          {t('colItems')}
                        </th>
                        <th className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colTotal')}
                        </th>
                        <th className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          {t('colAction')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {orders.map(order => {
                        // Find the refund payment (most-recent payment row with a
                        // non-zero refundedAmount). Refund metadata travels on
                        // the Payment row, not the Order, so the line below the
                        // main row needs to dig it out for display.
                        const refundedPayment = order.payments.find(
                          p => (p.refundedAmount ?? 0) > 0 || p.status === 'refunded'
                        );
                        return (
                          <Fragment key={order.id}>
                            <tr className="hover:bg-muted/30 transition-colors">
                              <td className="px-6 py-4 text-sm font-medium text-foreground">
                                {order.orderNumber || order.id.slice(0, 8)}
                              </td>
                              <td className="px-6 py-4 text-sm text-muted-foreground">
                                {formatDate(order.createdAt)}
                              </td>
                              <td className="px-6 py-4">
                                <StatusChip status={order.status} />
                              </td>
                              <td className="px-6 py-4">
                                <StatusChip status={order.paymentStatus} />
                                {order.payments[0] && (
                                  <span className="ms-2 text-xs text-muted-foreground">
                                    {t('via')} {order.payments[0].provider}
                                  </span>
                                )}
                              </td>
                              <td className="px-6 py-4 hidden md:table-cell text-sm text-muted-foreground">
                                {order.items.length}{' '}
                                <span className="text-xs">
                                  ({order.items.reduce((sum, it) => sum + it.quantity, 0)}{' '}
                                  {t('units')})
                                </span>
                              </td>
                              <td className="px-6 py-4 text-end text-sm font-bold text-foreground">
                                {formatKwd(order.total)}
                              </td>
                              <td className="px-6 py-4 text-end">
                                <Link
                                  href={`/stores/${storeId}/orders/${order.id}`}
                                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                                >
                                  {t('viewOrder')}
                                </Link>
                              </td>
                            </tr>
                            {refundedPayment && (
                              <tr className="bg-destructive/5">
                                <td
                                  colSpan={7}
                                  className="px-6 py-2 text-xs text-destructive border-t border-destructive/10"
                                >
                                  <span className="font-semibold">{t('refunded')}</span>
                                  {' · '}-{formatKwd(refundedPayment.refundedAmount ?? order.total)}{' '}
                                  {t('via')} {refundedPayment.provider}
                                  {refundedPayment.metadata?.refundedAt && (
                                    <>
                                      {' '}
                                      {t('refundedOn')}{' '}
                                      {formatDate(refundedPayment.metadata.refundedAt)}
                                    </>
                                  )}
                                  {refundedPayment.metadata?.refundReason && (
                                    <>
                                      {' · '}
                                      {t('refundedReason')}{' '}
                                      <em>{refundedPayment.metadata.refundReason}</em>
                                    </>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </AdminLayout>
  );
}
