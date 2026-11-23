'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button, buttonVariants } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AdminSkeletonTable } from '../../../../components/AdminSkeleton';
import { apiGet, apiFetch } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { RowActions } from '../../../../components/RowActions';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { SearchInput } from '@/components/SearchInput';
import { StatusFilterPills } from '@/components/StatusFilterPills';
import { CustomersKpiStrip, type CustomersSummary } from './_components/CustomersKpiStrip';
import {
  SEGMENT_BADGE_CLASSES,
  badgeKeyFor,
  parseSegmentParam,
  segmentFilterOptions,
  ERASURE_REVIEW_PARAM,
  type SegmentFilter,
} from './_components/customerSegments';

const CUSTOMERS_PAGE_SIZE = 20;

interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  totalOrders: number;
  /** Sum of every order's total (all statuses), in piastres. */
  totalSpent: number;
  /** totalSpent / totalOrders, in piastres (0 for a zero-order customer). */
  avgOrderValue: number;
  // Null for a registered shopper with zero orders (#1882).
  lastOrderDate: string | null;
  /** True when the row was synthesized from a guest order (no customer User row). */
  isGuest: boolean;
  /** RFM segment resolved server-side (guests included); null = no snapshot.
   *  Absent for staff, who do not receive segments. */
  segment?: string | null;
  /** Promotional-SMS consent (issue 206): 'granted' | 'revoked' | 'none'. */
  smsMarketingConsent?: 'granted' | 'revoked' | 'none';
  // The API row also carries the latest address and payment status; the list
  // no longer shows them — they live on the customer detail page, which has
  // the full address block and per-order payment status (audit 2026-09-30 §10).
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
    /** The SQL search hit its own cap: these rows are the first of more. */
    searchTruncated?: boolean;
    /** Store-wide KPI strip — unaffected by page, search or segment. */
    summary?: CustomersSummary;
    /** RFM segments present anywhere in the store (filter pills). */
    segments?: string[];
  };
}

import { formatDate, formatPrice } from '@/lib/format';
import { customerListFilterParams, moveSearchToHeader } from '@ebda/shared';

export default function StoreCustomersPage() {
  const { user } = useAuth();
  const canExport = !!user && user.role !== 'staff';
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('customers.page');
  const tPrivacy = useT('customers.detail.privacy');
  const tc = useT('common');
  const locale = useLocale();

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [presentSegments, setPresentSegments] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Committed (already debounced by the shared SearchInput) search term.
  const [search, setSearch] = useState('');
  // Seeded from `?segment=` so a segment card on Insights → Segments lands
  // here already filtered (the drill-down), and a reload keeps the filter.
  const [segment, setSegment] = useState<SegmentFilter>(() =>
    parseSegmentParam(searchParams?.get('segment'))
  );
  const [summary, setSummary] = useState<CustomersSummary | null>(null);
  // Server-side pagination state.
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // True when the server capped the order scan (very large store) — surfaced
  // as a notice so the merchant knows the list may be partial.
  const [truncated, setTruncated] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const { error: toastError } = useToast();

  // A search or segment change starts from page 1. Reset in the HANDLER, not
  // in an effect: an effect ran after the fetch effect of the same commit, so
  // every change fired two list requests (old page, then page 1) and the
  // older could land last (#2234). `beginRequest` guards the remaining case —
  // any two overlapping fetches.
  const beginRequest = useLatestRequest();
  const changeSearch = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);
  const changeSegment = useCallback((value: SegmentFilter) => {
    setSegment(value);
    setPage(1);
  }, []);

  // Keep `?segment=` in step with the pills so the filtered view is
  // shareable and survives back-navigation from a customer's detail page.
  useEffect(() => {
    const current = searchParams?.get('segment') ?? null;
    const wanted = segment === 'all' ? null : segment;
    if (current === wanted || !pathname) return;
    const qs = new URLSearchParams(searchParams?.toString() ?? '');
    if (wanted) qs.set('segment', wanted);
    else qs.delete('segment');
    const q = qs.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }, [segment, pathname, router, searchParams]);

  /**
   * Fetch a single page of aggregated customers from the server. The previous
   * implementation read orders page-1 then fired `Promise.all` over EVERY
   * remaining page (a 49+ concurrent-request fan-out on a large store). The
   * aggregation now happens server-side, bounded + paginated, so this is a
   * single request per page.
   */
  const fetchCustomers = useCallback(async () => {
    if (!storeId) return;
    const isLatest = beginRequest();
    setIsLoading(true);
    setError(null);

    try {
      const { params: qs, headers } = moveSearchToHeader(
        customerListFilterParams({
          search,
          segment: segment === 'all' ? undefined : segment,
        })
      );
      qs.set('page', String(page));
      qs.set('perPage', String(CUSTOMERS_PAGE_SIZE));

      const { data, error: fetchError } = await apiGet<CustomersListResponse>(
        `/api/v1/stores/${storeId}/customers?${qs.toString()}`,
        headers
      );
      if (!isLatest()) return;

      if (fetchError || !data) {
        setError(fetchError?.message || t('fetchFailed'));
        setCustomers([]);
        setTotalCount(0);
        setTotalPages(1);
        // Unknown, not zero: the KPI strip renders "Unknown" for a null summary.
        setSummary(null);
        return;
      }

      setCustomers(data.data ?? []);
      setTotalCount(data.meta?.total ?? 0);
      setTotalPages(Math.max(1, data.meta?.totalPages ?? 1));
      setTruncated(Boolean(data.meta?.truncated));
      setSearchTruncated(Boolean(data.meta?.searchTruncated));
      setSummary(data.meta?.summary ?? null);
      setPresentSegments(data.meta?.segments ?? []);
    } catch {
      if (!isLatest()) return;
      setError(t('connectionError'));
      setSummary(null);
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [storeId, t, page, search, segment, beginRequest]);

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
      // Export what is on screen: the same search + segment the list sends.
      const { params: qs, headers } = moveSearchToHeader(
        customerListFilterParams({
          search,
          segment: segment === 'all' ? undefined : segment,
        })
      );
      const suffix = qs.toString() ? `?${qs}` : '';
      const res = await apiFetch(`/api/v1/stores/${storeId}/customers/export.xlsx${suffix}`, {
        headers,
      });
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
  }, [storeId, isExporting, search, segment, t, toastError]);

  const pageDir = locale === 'ar' ? 'rtl' : 'ltr';
  /** The route param accepts either a User.id UUID or a guest synthetic key
   *  (email / phone) — encoded because email keys contain @. */
  const customerHref = (customer: CustomerRow) =>
    `/stores/${storeId}/customers/${encodeURIComponent(customer.id)}`;

  const segmentOptions = useMemo(
    () =>
      // The active segment stays selectable even when the store has no member
      // in it (a drill-down link to an emptied segment still shows its pill).
      // The active segment ALWAYS stays among the pills (#2222) — `guest`
      // included, whose pill otherwise hangs off `summary`, which is null
      // while loading or after an error — so the group can never hide, or
      // leave no tabbable pill, while a filter is still applied.
      segmentFilterOptions(
        segment === 'all' || segment === 'guest' ? presentSegments : [...presentSegments, segment],
        (summary?.guests ?? 0) > 0 || segment === 'guest'
      ).map(value => ({
        value,
        label: value === 'all' ? t('segmentAll') : t(`badges.${value}`),
      })),
    [presentSegments, segment, summary?.guests, t]
  );

  /**
   * Six columns, scan order name → segment → value: Customer (avatar, name,
   * phone, segment badge) · Orders · Total spent · Avg order · Last order ·
   * View. Email, address and last-payment status live on the detail page.
   */
  const columns: DataTableColumn<CustomerRow>[] = [
    {
      header: t('colCustomer'),
      primaryOnMobile: true,
      cell: customer => {
        const badgeKey = badgeKeyFor(customer, customer.segment ?? undefined);
        const name = `${customer.firstName} ${customer.lastName}`.trim();
        return (
          // Explicit page direction: DataTable wraps every cell in <bdi>, which
          // auto-detects direction from the first strong character — an
          // Arabic name then flipped the whole cell (avatar to the far side)
          // on the English UI. A `dir` on this root pins the layout; the
          // name itself stays `dir="auto"` so it still reads correctly.
          <div className="flex min-w-0 items-center gap-2.5" dir={pageDir}>
            <div
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary-ink"
              aria-hidden="true"
            >
              {customer.firstName?.[0]}
              {customer.lastName?.[0]}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link
                  href={customerHref(customer)}
                  dir="auto"
                  className="truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                >
                  {name || customer.email || customer.phone}
                </Link>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEGMENT_BADGE_CLASSES[badgeKey]}`}
                >
                  {t(`badges.${badgeKey}`)}
                </span>
                {customer.smsMarketingConsent === 'granted' && (
                  <span
                    data-sms-consent-badge
                    className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-ink"
                    title={t('smsConsentBadgeTitle')}
                  >
                    {t('smsConsentBadge')}
                  </span>
                )}
              </div>
              {customer.phone && (
                <p className="text-xs text-muted-foreground" dir="ltr">
                  {customer.phone}
                </p>
              )}
            </div>
          </div>
        );
      },
    },
    {
      header: t('colOrders'),
      alignEnd: true,
      hideOnMobile: true,
      cell: customer => (
        <span className="text-sm tabular-nums text-foreground">{customer.totalOrders}</span>
      ),
    },
    {
      header: t('colSpent'),
      alignEnd: true,
      mobileBadge: true,
      cell: customer => (
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {formatPrice(customer.totalSpent)}
        </span>
      ),
    },
    {
      header: t('colAvgOrder'),
      alignEnd: true,
      hideOnMobile: true,
      cell: customer =>
        customer.totalOrders > 0 ? (
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatPrice(customer.avgOrderValue)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground/60">—</span>
        ),
    },
    {
      header: t('colLastOrder'),
      cell: customer => (
        <span className="text-sm text-muted-foreground">{formatDate(customer.lastOrderDate)}</span>
      ),
    },
    {
      header: <span className="sr-only">{t('colActions')}</span>,
      alignEnd: true,
      // On phones the name is the link (above); a full-width button row per
      // card doubled every card's height.
      hideOnMobile: true,
      cell: customer => (
        <Link
          href={customerHref(customer)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          title={t('viewCustomerTitle')}
        >
          {t('viewCustomer')}
        </Link>
      ),
    },
  ];

  const emptyState = (
    <div className="force-empty-state">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-muted">
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
      <p className="font-semibold text-foreground">
        {search || segment !== 'all' ? t('noMatch') : t('empty')}
      </p>
      {!search && segment === 'all' && (
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
        // Rule 2: customers are made by orders, so the page has no primary; export (owners only, SEC-14: the API
        // answers 403 to staff) is the one extra action and lives in the "..." menu.
        canExport ? (
          <RowActions
            menuLabel={t('moreMenu')}
            items={[
              {
                label: isExporting ? t('exporting') : t('exportXlsx'),
                onSelect: handleExport,
                disabled: isLoading || isExporting || customers.length === 0,
              },
            ]}
          />
        ) : undefined
      }
    >
      <div className="space-y-4">
        <CustomersKpiStrip
          summary={summary}
          isLoading={isLoading && !summary}
          truncated={truncated}
        />

        {/* Filter bar — the shared SearchInput (same debounce + look as
            Products) and segment pills built from the already-loaded RFM
            snapshots. Both filter server-side, over the whole store. */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput
              value={search}
              onSearch={changeSearch}
              placeholder={t('searchPlaceholder')}
              className="w-full sm:w-72"
            />
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {isLoading
                ? t('loading')
                : totalCount === 1
                  ? t('countSingular', { count: totalCount })
                  : t('countPlural', { count: totalCount })}
            </span>
          </div>
          {segmentOptions.length > 1 && (
            <div className="-mx-1 overflow-x-auto px-1">
              <StatusFilterPills
                ariaLabel={t('segmentFilterLabel')}
                options={segmentOptions}
                value={segment}
                onChange={changeSegment}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-muted p-1"
              />
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive-ink">
            {error}
            <button type="button" className="ms-4 font-medium underline" onClick={fetchCustomers}>
              {t('retry')}
            </button>
          </div>
        )}

        {/* An erasure left an ambiguous CRM match for the merchant to delete by
            hand (#2229) — said here, on the list they were sent to, until
            they dismiss it, not only in a toast. */}
        {searchParams?.get(ERASURE_REVIEW_PARAM) === '1' && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-warning-ink"
          >
            <div>
              <p className="font-semibold">{tPrivacy('erasedCrmReviewTitle')}</p>
              <p className="mt-1">{tPrivacy('erasedCrmAmbiguous')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              type="button"
              onClick={() => {
                const qs = new URLSearchParams(searchParams?.toString() ?? '');
                qs.delete(ERASURE_REVIEW_PARAM);
                const q = qs.toString();
                if (pathname) router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
              }}
            >
              {tc('close')}
            </Button>
          </div>
        )}

        {/* Truncation notice — the server capped the order scan on a very large
          store, so this list aggregates only the most recent orders. */}
        {truncated && (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-warning-ink">
            {t('truncatedNotice')}
          </div>
        )}

        {searchTruncated && (
          <div
            role="status"
            className="rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-warning-ink"
          >
            {t('searchTruncatedNotice', { shown: totalCount })}
          </div>
        )}

        {/* Customers table */}
        {isLoading ? (
          <AdminSkeletonTable rows={6} columns={6} showToolbar={false} />
        ) : (
          <DataTable
            ariaLabel={t('tableLabel')}
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
          <div className="flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {t('paginationShowing', {
                from: (page - 1) * CUSTOMERS_PAGE_SIZE + 1,
                to: Math.min(page * CUSTOMERS_PAGE_SIZE, totalCount),
                total: totalCount,
              })}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                disabled={page === totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
