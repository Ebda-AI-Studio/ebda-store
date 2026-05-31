'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiFetch, unwrapList } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
}

interface OrderShippingAddress {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  area?: string;
  state?: string;
  country?: string;
  postalCode?: string;
}

interface Order {
  id: string;
  orderNumber?: string;
  customer: OrderCustomer | null;
  total: number;
  status?: string;
  paymentStatus?: string;
  createdAt: string;
  shippingAddress?: OrderShippingAddress | null;
}

interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /**
   * Latest order's shipping address as a single human-readable string.
   * Joined "address1, address2, area, city, country" with commas and
   * the empty slots dropped. Empty when the merchant collected no
   * address (e.g. digital-only orders).
   */
  address: string;
  totalOrders: number;
  totalSpent: number;
  /**
   * Total of the LATEST order (not the sum). Surfaces "what did this
   * customer just spend?" — distinct from totalSpent which aggregates
   * across all their orders. Per Ahmad 2026-05-16: 'add ... how much
   * is the payment per order'.
   */
  lastOrderTotal: number;
  lastOrderDate: string;
  lastOrderId: string;
  lastOrderNumber?: string;
  /** Status of the latest order so a 'cancelled' chip can show inline. */
  lastOrderStatus?: string;
  /** Payment status of the latest order. */
  lastOrderPaymentStatus?: string;
  /** True when the row was synthesized from a guest order (no customer User row). */
  isGuest: boolean;
}

/**
 * Pretty-print a shipping address. Returns "" if every slot is empty.
 * Used to surface the latest delivery destination on the customers
 * table per Ahmad 2026-05-16 ask.
 */
function formatShippingAddress(addr: OrderShippingAddress | null | undefined): string {
  if (!addr) return '';
  const parts = [addr.address1, addr.address2, addr.area, addr.city, addr.country].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0
  );
  return parts.join(', ');
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Segment → color classes for the badge. Labels are resolved via i18n
 * (`customers.page.badges.<segment>`) so they render bilingual. The two
 * fallback badges ("activeBuyer" / "new") cover customers who have no RFM
 * snapshot yet (zero-order or not-yet-analysed) so EVERY row shows a badge.
 */
const RFM_BADGE_COLORS: Record<string, { bg: string; text: string }> = {
  vip: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  loyal: { bg: 'bg-green-100', text: 'text-green-800' },
  potential: { bg: 'bg-blue-100', text: 'text-blue-800' },
  new_customer: { bg: 'bg-info/10', text: 'text-info' },
  at_risk: { bg: 'bg-warning/10', text: 'text-warning-foreground' },
  hibernating: { bg: 'bg-muted', text: 'text-muted-foreground' },
  lost: { bg: 'bg-destructive/10', text: 'text-destructive' },
  // Fallback badges (no RFM snapshot)
  activeBuyer: { bg: 'bg-blue-100', text: 'text-blue-800' },
  new: { bg: 'bg-info/10', text: 'text-info' },
};

export default function StoreCustomersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('customers.page');

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [rfmMap, setRfmMap] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Track whether we are still fetching additional pages beyond the first
  const [isFetchingAll, setIsFetchingAll] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const { error: toastError } = useToast();

  /**
   * Fetch all orders for the store across all pages, then deduplicate by
   * customer to build the customer list. The orders endpoint is paginated so
   * we loop until we have every page.
   */
  const fetchCustomers = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);

    try {
      const limit = 100;

      // Fetch first page to learn total. API wraps paging in `meta`, NOT
      // `pagination` — the previous shape mismatch silently capped this
      // page at the first 100 orders forever (Ahmad 2026-05-16: 'why new
      // orders customer info not loaded').
      const { data: firstData, error: firstError } = await apiGet<{
        orders: Order[];
        meta?: { totalPages: number };
      }>(`/api/v1/stores/${storeId}/orders?page=1&limit=${limit}`);

      if (firstError || !firstData) {
        // Set the per-fetch error and fall through to `finally` so the
        // customers table keeps rendering (empty state + inline retry).
        // The original `return` here caused a blank table body — removed.
        setError(firstError?.message || t('fetchFailed'));
        setCustomers([]);
        return;
      }

      const allOrders: Order[] = firstData.orders ?? [];
      const totalPages: number = firstData.meta?.totalPages ?? 1;

      // Fetch remaining pages in parallel if there are more
      if (totalPages > 1) {
        setIsFetchingAll(true);
        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const remainingResults = await Promise.all(
          pageNumbers.map(async pageNum => {
            const { data } = await apiGet<{ orders: Order[] }>(
              `/api/v1/stores/${storeId}/orders?page=${pageNum}&limit=${limit}`
            );
            return data?.orders ?? [];
          })
        );
        for (const pageOrders of remainingResults) {
          allOrders.push(...pageOrders);
        }
        setIsFetchingAll(false);
      }

      // Aggregate orders by customer. Two passes through the same loop:
      // 1) registered customer (User row) keyed by customer.id
      // 2) guest checkout (no User row) keyed by shippingAddress email
      //    or phone — Ahmad 2026-05-16: 'get the info even if cancelled
      //    or unpaid'. Cancelled / failed / pending orders still count
      //    because the API doesn't filter by status either.
      const customerMap = new Map<string, CustomerRow>();

      for (const order of allOrders) {
        const ship = order.shippingAddress;
        const isGuest = !order.customer?.id;
        const key =
          order.customer?.id ||
          ship?.email?.toLowerCase() ||
          ship?.phone ||
          // last-resort synthetic key keeps each guest order as its own
          // row instead of silently merging unrelated guest orders.
          `guest:${order.id}`;

        const firstName = order.customer?.firstName || ship?.firstName || '';
        const lastName = order.customer?.lastName || ship?.lastName || '';
        const email = order.customer?.email || ship?.email || '';
        const phone = order.customer?.phone || ship?.phone || '';
        const address = formatShippingAddress(ship);

        const existing = customerMap.get(key);
        if (existing) {
          existing.totalOrders += 1;
          existing.totalSpent += order.total;
          // Keep track of the most recent order
          if (order.createdAt > existing.lastOrderDate) {
            existing.lastOrderDate = order.createdAt;
            existing.lastOrderId = order.id;
            existing.lastOrderNumber = order.orderNumber;
            existing.lastOrderTotal = order.total;
            existing.lastOrderStatus = order.status;
            existing.lastOrderPaymentStatus = order.paymentStatus;
            // Latest order's address + phone + name win when newer
            if (address) existing.address = address;
            if (phone) existing.phone = phone;
            if (firstName) existing.firstName = firstName;
            if (lastName) existing.lastName = lastName;
            if (email && !existing.email) existing.email = email;
          } else {
            if (!existing.phone && phone) existing.phone = phone;
            if (!existing.address && address) existing.address = address;
          }
        } else {
          customerMap.set(key, {
            id: order.customer?.id || key,
            firstName,
            lastName,
            email,
            phone,
            address,
            totalOrders: 1,
            totalSpent: order.total,
            lastOrderTotal: order.total,
            lastOrderDate: order.createdAt,
            lastOrderId: order.id,
            lastOrderNumber: order.orderNumber,
            lastOrderStatus: order.status,
            lastOrderPaymentStatus: order.paymentStatus,
            isGuest,
          });
        }
      }

      // Sort by total spent descending
      const sorted = Array.from(customerMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);
      setCustomers(sorted);
    } catch {
      setError(t('connectionError'));
    } finally {
      setIsLoading(false);
    }

    // Segments / RFM fetch is intentionally OUTSIDE the main try/catch so
    // a segments API failure never sets the customers-page error state and
    // never leaves the table blank. Badges simply stay hidden.
    apiGet<Array<{ customerId: string; segment: string }>>(
      `/api/v1/stores/${storeId}/insights/customers/rfm-batch`
    )
      .then(({ data }) => {
        if (!data) return;
        const rows = unwrapList<{ customerId: string; segment: string }>(data);
        setRfmMap(
          new Map(
            rows.map((r: { customerId: string; segment: string }) => [r.customerId, r.segment])
          )
        );
      })
      .catch(() => {
        // insights not yet computed — RFM badges stay hidden, no error state
      });
  }, [storeId, t]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const filteredCustomers = customers.filter(customer => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      customer.firstName.toLowerCase().includes(s) ||
      customer.lastName.toLowerCase().includes(s) ||
      customer.email.toLowerCase().includes(s) ||
      (customer.phone?.toLowerCase().includes(s) ?? false)
    );
  });

  /**
   * Trigger the server-side XLSX export. We hit the API via raw fetch
   * (instead of apiGet) because the response is a binary stream, and we
   * pull it into a Blob → object URL → anchor click to save the file.
   */
  const handleExport = useCallback(async () => {
    if (!storeId || isExporting) return;
    setIsExporting(true);
    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/customers/export.xlsx`);
      if (!res.ok) {
        toastError(t('exportFailed'));
        return;
      }
      const blob = await res.blob();
      const filename = (() => {
        const cd = res.headers.get('content-disposition') ?? '';
        const match = cd.match(/filename="?([^"]+)"?/i);
        return match?.[1] ?? `customers-${new Date().toISOString().slice(0, 10)}.xlsx`;
      })();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toastError(t('exportFailed'));
    } finally {
      setIsExporting(false);
    }
  }, [storeId, isExporting, t, toastError]);

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleExport}
            disabled={isLoading || isExporting || customers.length === 0}
          >
            <svg
              className="h-4 w-4 me-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            {isExporting ? t('exporting') : t('exportXlsx')}
          </Button>
          <Link href={`/stores/${storeId}`}>
            <Button type="button" variant="outline">
              {t('backToStore')}
            </Button>
          </Link>
        </div>
      }
    >
      {/* Search bar */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {isLoading || isFetchingAll
              ? t('loading')
              : filteredCustomers.length === 1
                ? t('countSingular', { count: filteredCustomers.length })
                : t('countPlural', { count: filteredCustomers.length })}
          </span>
          {isFetchingAll && (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <svg
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border py-2 ps-10 pe-4 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchCustomers}>
            {t('retry')}
          </button>
        </div>
      )}

      {/* Customers table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="space-y-4 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="h-3 w-48 rounded bg-muted" />
                </div>
                <div className="h-6 w-20 rounded bg-muted" />
                <div className="h-6 w-20 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="force-empty-state">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>
            <p className="font-semibold text-foreground">{search ? t('noMatch') : t('empty')}</p>
            {!search && (
              <>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  {t('emptyDescription')}
                </p>
                <Link href={`/stores/${storeId}/products/new`} className="mt-4 inline-block">
                  <Button size="sm">{t('emptyAddProduct')}</Button>
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" aria-label={t('tableLabel')}>
              <thead className="bg-muted border-b">
                <tr>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colCustomer')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colEmail')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colPhone')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colOrders')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colSpent')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell"
                  >
                    Last Payment
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell"
                  >
                    Address
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell"
                  >
                    {t('colLastOrder')}
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('colActions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredCustomers.map(customer => (
                  <tr key={customer.id} className="hover:bg-muted transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {/* Avatar with initials */}
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary flex-shrink-0">
                          {customer.firstName?.[0]}
                          {customer.lastName?.[0]}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <p className="font-medium text-foreground">
                            {customer.firstName} {customer.lastName}
                          </p>
                          {(() => {
                            const seg = rfmMap.get(customer.id);
                            // Use the RFM segment badge when the customer has a
                            // snapshot; otherwise fall back so EVERY customer
                            // shows a badge: "Active Buyer" for anyone who has
                            // ordered, "New" for zero-order registrations.
                            const badgeKey =
                              seg && RFM_BADGE_COLORS[seg]
                                ? seg
                                : customer.totalOrders >= 1
                                  ? 'activeBuyer'
                                  : 'new';
                            const colors = RFM_BADGE_COLORS[badgeKey];
                            return (
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${colors.bg} ${colors.text}`}
                              >
                                {t(`badges.${badgeKey}`)}
                              </span>
                            );
                          })()}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">{customer.email}</td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {customer.phone ? (
                        <a
                          href={`tel:${customer.phone}`}
                          className="hover:text-foreground transition-colors"
                          dir="ltr"
                        >
                          {customer.phone}
                        </a>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full bg-info/5 px-2.5 py-1 text-xs font-medium text-info">
                        {customer.totalOrders === 1
                          ? t('orderCount', { count: customer.totalOrders })
                          : t('ordersCount', { count: customer.totalOrders })}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-bold text-foreground">
                        {(customer.totalSpent / 1000).toFixed(3)} KWD
                      </span>
                    </td>
                    <td className="px-6 py-4 hidden lg:table-cell text-sm text-foreground">
                      <span className="font-medium">
                        {(customer.lastOrderTotal / 1000).toFixed(3)} KWD
                      </span>
                      {customer.lastOrderPaymentStatus && (
                        <span
                          className={`ms-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            customer.lastOrderPaymentStatus === 'paid'
                              ? 'bg-success/10 text-success'
                              : customer.lastOrderPaymentStatus === 'failed'
                                ? 'bg-destructive/10 text-destructive'
                                : 'bg-warning/10 text-warning'
                          }`}
                        >
                          {customer.lastOrderPaymentStatus}
                        </span>
                      )}
                      {customer.lastOrderStatus === 'cancelled' && (
                        <span className="ms-2 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                          cancelled
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 hidden lg:table-cell text-sm text-muted-foreground max-w-xs">
                      {customer.address ? (
                        <span className="line-clamp-2" title={customer.address}>
                          {customer.address}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell text-sm text-muted-foreground">
                      {formatDate(customer.lastOrderDate)}
                    </td>
                    <td className="px-6 py-4 text-end">
                      {/* Link to the customer detail page (full profile +
                          every order). The route param accepts either a
                          User.id UUID or a guest synthetic key (email /
                          phone). Encoded because email keys contain @. */}
                      <Link
                        href={`/stores/${storeId}/customers/${encodeURIComponent(customer.id)}`}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                        title={t('viewOrdersTitle')}
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                          />
                        </svg>
                        {t('viewOrders')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
