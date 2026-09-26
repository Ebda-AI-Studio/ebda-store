'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiFetch, unwrapList } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

const CUSTOMERS_PAGE_SIZE = 20;

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
  // Null for a registered shopper with zero orders (#1882).
  lastOrderDate: string | null;
  /** Status of the latest order so a 'cancelled' chip can show inline. */
  lastOrderStatus?: string;
  /** Payment status of the latest order. */
  lastOrderPaymentStatus?: string;
  /** True when the row was synthesized from a guest order (no customer User row). */
  isGuest: boolean;
}

/** Paginated customers list response from the server-side aggregation. */
interface CustomersListResponse {
  data: CustomerRow[];
  meta: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    truncated: boolean;
  };
}

import { formatDate, formatPrice } from '@/lib/format';

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
  // Debounced search term actually sent to the server (300ms after typing).
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Server-side pagination state.
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // True when the server capped the order scan (very large store) — surfaced
  // as a notice so the merchant knows the list may be partial.
  const [truncated, setTruncated] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const { error: toastError } = useToast();

  // Debounce the search input so we don't hit the aggregation endpoint on
  // every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Reset to page 1 whenever the (debounced) search term changes so results
  // always start from the beginning of the filtered set.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  /**
   * Fetch a single page of aggregated customers from the server. The previous
   * implementation read orders page-1 then fired `Promise.all` over EVERY
   * remaining page (a 49+ concurrent-request fan-out on a large store). The
   * aggregation now happens server-side, bounded + paginated, so this is a
   * single request per page.
   */
  const fetchCustomers = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);

    try {
      const qs = new URLSearchParams({
        page: String(page),
        perPage: String(CUSTOMERS_PAGE_SIZE),
      });
      if (debouncedSearch) qs.set('search', debouncedSearch);

      const { data, error: fetchError } = await apiGet<CustomersListResponse>(
        `/api/v1/stores/${storeId}/customers?${qs.toString()}`
      );

      if (fetchError || !data) {
        setError(fetchError?.message || t('fetchFailed'));
        setCustomers([]);
        setTotalCount(0);
        setTotalPages(1);
        return;
      }

      setCustomers(data.data ?? []);
      setTotalCount(data.meta?.total ?? 0);
      setTotalPages(Math.max(1, data.meta?.totalPages ?? 1));
      setTruncated(Boolean(data.meta?.truncated));
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
  }, [storeId, t, page, debouncedSearch]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // The server already paginated + filtered; the current page rows render
  // directly. Aliased to keep the render block below unchanged.
  const pagedCustomers = customers;

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

  /** DataTable column definitions — closed over rfmMap + storeId. */
  const columns: DataTableColumn<CustomerRow>[] = [
    {
      header: t('colCustomer'),
      primaryOnMobile: true,
      cell: customer => {
        const seg = rfmMap.get(customer.id);
        // Use the RFM segment badge when the customer has a
        // snapshot; otherwise fall back so EVERY customer
        // shows a badge: "Active Buyer" for anyone who has
        // ordered, "New" for zero-order registrations.
        const badgeKey =
          seg && RFM_BADGE_COLORS[seg] ? seg : customer.totalOrders >= 1 ? 'activeBuyer' : 'new';
        const colors = RFM_BADGE_COLORS[badgeKey];
        return (
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
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${colors.bg} ${colors.text}`}
              >
                {t(`badges.${badgeKey}`)}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      header: t('colOrders'),
      mobileBadge: true,
      cell: customer => (
        <span className="inline-flex items-center rounded-full bg-info/5 px-2.5 py-1 text-xs font-medium text-info">
          {customer.totalOrders === 1
            ? t('orderCount', { count: customer.totalOrders })
            : t('ordersCount', { count: customer.totalOrders })}
        </span>
      ),
    },
    {
      header: t('colEmail'),
      cell: customer => <span className="text-sm text-muted-foreground">{customer.email}</span>,
    },
    {
      header: t('colPhone'),
      cell: customer =>
        customer.phone ? (
          <a
            href={`tel:${customer.phone}`}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            dir="ltr"
          >
            {customer.phone}
          </a>
        ) : (
          <span className="text-sm text-muted-foreground/60">—</span>
        ),
    },
    {
      header: t('colSpent'),
      alignEnd: true,
      cell: customer => (
        <span className="font-bold text-foreground">{formatPrice(customer.totalSpent)}</span>
      ),
    },
    {
      // Last Payment column — hidden on mobile to keep cards lean; shown at desktop lg+
      header: t('colLastPayment'),
      hideOnMobile: true,
      cell: customer => (
        <div className="text-sm text-foreground">
          <span className="font-medium">{formatPrice(customer.lastOrderTotal)}</span>
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
              {t('statusCancelled')}
            </span>
          )}
        </div>
      ),
    },
    {
      header: t('colAddress'),
      hideOnMobile: true,
      cell: customer =>
        customer.address ? (
          <span
            className="text-sm text-muted-foreground line-clamp-2 max-w-xs"
            title={customer.address}
          >
            {customer.address}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground/60">—</span>
        ),
    },
    {
      header: t('colLastOrder'),
      hideOnMobile: true,
      cell: customer => (
        <span className="text-sm text-muted-foreground">{formatDate(customer.lastOrderDate)}</span>
      ),
    },
    {
      header: t('colActions'),
      alignEnd: true,
      mobileActions: true,
      cell: customer => (
        /* Link to the customer detail page (full profile +
           every order). The route param accepts either a
           User.id UUID or a guest synthetic key (email /
           phone). Encoded because email keys contain @. */
        <Link
          href={`/stores/${storeId}/customers/${encodeURIComponent(customer.id)}`}
          className="min-h-11 inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
          title={t('viewOrdersTitle')}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          {t('viewOrders')}
        </Link>
      ),
    },
  ];

  const emptyState = (
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
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
          <Link href={`/stores/${storeId}/products/new`} className="mt-4 inline-block">
            <Button size="sm">{t('emptyAddProduct')}</Button>
          </Link>
        </>
      )}
    </div>
  );

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
            {isLoading
              ? t('loading')
              : totalCount === 1
                ? t('countSingular', { count: totalCount })
                : t('countPlural', { count: totalCount })}
          </span>
          {isLoading && (
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

      {/* Truncation notice — the server capped the order scan on a very large
          store, so this list aggregates only the most recent orders. */}
      {truncated && (
        <div className="mb-6 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-foreground">
          {t('truncatedNotice')}
        </div>
      )}

      {/* Customers table */}
      {isLoading ? (
        <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
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
      ) : (
        <DataTable
          columns={columns}
          rows={pagedCustomers}
          rowKey={c => c.id}
          emptyState={emptyState}
        />
      )}

      {/* Pagination controls — only rendered when there is more than
          one page. The "Showing X to Y of Z" line is always visible
          when the table is non-empty so merchants know how many
          customers they have at a glance. */}
      {!isLoading && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between rounded-xl border bg-card px-6 py-3 shadow-sm">
          <p className="text-sm text-muted-foreground">
            {t('paginationShowing', {
              from: (page - 1) * CUSTOMERS_PAGE_SIZE + 1,
              to: Math.min(page * CUSTOMERS_PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
