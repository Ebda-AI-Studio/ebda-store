'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button, buttonVariants } from '@/components/ui/Button';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost, apiFetch } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { EraseCustomerModal } from './_components/EraseCustomerModal';
import { CustomerWalletCard } from './_components/CustomerWalletCard';
import { useFeatures } from '../../../../../hooks/useFeatures';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

interface CustomerGroupOption {
  id: string;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  /** B2B: a wholesale group and/or a group percent discount decide this customer's prices. */
  isWholesale?: boolean;
  pricingMode?: 'none' | 'percent_off';
  discountBps?: number;
}

interface CustomerDetail {
  id: string;
  isGuest: boolean;
  groupId: string | null;
  group: { id: string; name: string; nameAr: string | null } | null;
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
  // Null for a registered shopper who has never placed an order (#1882) —
  // the aggregation is otherwise entirely order-derived.
  firstOrderDate: string | null;
  lastOrderDate: string | null;
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

/** Promotional-SMS consent for this customer in this store (issue 206). */
interface SmsMarketingConsent {
  status: 'granted' | 'revoked' | 'none';
  phone: string | null;
  grantedAt: string | null;
  grantedSource: 'checkout' | 'account' | 'unsubscribe' | null;
  revokedAt: string | null;
  revokedSource: 'checkout' | 'account' | 'unsubscribe' | null;
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
import { ERASURE_REVIEW_PARAM } from '../_components/customerSegments';
import { useT } from '../../../../../i18n/useT';
import { FIELD_CLASSES } from '@/components/ui/tokens';

function formatMajor(piastres: number): string {
  return formatPrice(piastres);
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === 'paid' || status === 'completed' || status === 'confirmed'
      ? 'bg-success/10 text-success-ink'
      : status === 'cancelled' || status === 'failed' || status === 'refunded'
        ? 'bg-destructive/10 text-destructive-ink'
        : 'bg-warning/10 text-warning-ink';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const customerKey = params?.customerKey as string;

  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [smsConsent, setSmsConsent] = useState<SmsMarketingConsent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<CustomerGroupOption[]>([]);
  const [savingGroup, setSavingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [isExportingData, setIsExportingData] = useState(false);
  const [isErasing, setIsErasing] = useState(false);
  const [showEraseModal, setShowEraseModal] = useState(false);
  const t = useT('customers.detail');
  const tPrivacy = useT('customers.detail.privacy');
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError, addToast } = useToast();
  // Owner/admin roles only — matches the API's `authorize('store_admin',
  // 'super_admin')` on both routes. Hiding the card for staff/other roles
  // is UX only; the API is the real gate.
  const canManagePrivacy = user?.role === 'store_admin' || user?.role === 'super_admin';
  // Customer wallet (D1): the card renders only once the feature map has
  // loaded AND `customer_wallet` is on — never on the loading default — so a
  // store without the feature sees this page exactly as before.
  const { isEnabled: isFeatureEnabled, isLoading: featuresLoading } = useFeatures();
  const walletEnabled = !featuresLoading && isFeatureEnabled('customer_wallet');
  const [walletBalance, setWalletBalance] = useState(0);
  const tWallet = useT('customers.detail.wallet');

  const fetchDetail = useCallback(async () => {
    if (!storeId || !customerKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{
        customer: CustomerDetail;
        orders: OrderRow[];
        smsMarketingConsent?: SmsMarketingConsent;
      }>(`/api/v1/stores/${storeId}/customers/${encodeURIComponent(customerKey)}`);
      if (apiError) {
        setError(apiError.message || t('fetchFailed'));
      } else if (data) {
        setCustomer(data.customer);
        setOrders(data.orders);
        setSmsConsent(data.smsMarketingConsent ?? null);
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

  // Grouping keys on contact identity (phone-first, email fallback), so any
  // customer with a phone or email can be grouped — registered or a guest with
  // contact details. A fully anonymous guest (neither) has nothing to key on.
  const canGroup = Boolean(customer && (customer.phone || customer.email));

  useEffect(() => {
    if (!storeId || !canGroup) return;
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<{ groups: CustomerGroupOption[] }>(
        `/api/v1/stores/${storeId}/customer-groups`
      );
      if (!cancelled && data) setGroups(data.groups);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId, canGroup]);

  const assignGroup = useCallback(
    async (groupId: string | null) => {
      if (!customer || !(customer.phone || customer.email)) return;
      setSavingGroup(true);
      setGroupError(null);
      // Optimistic: reflect the pick immediately, roll back on failure.
      const prev = { groupId: customer.groupId, group: customer.group };
      const nextGroup = groups.find(g => g.id === groupId) ?? null;
      setCustomer({
        ...customer,
        groupId,
        group: nextGroup
          ? { id: nextGroup.id, name: nextGroup.name, nameAr: nextGroup.nameAr }
          : null,
      });
      // Assign by contact identity — the detail page holds a User id, not a
      // Customer id, so the id-based endpoint can't be used here.
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/customers/group-assignment`,
        {
          // A registered shopper's profile is keyed by the user id: send it so the server binds the group to THAT
          // account (customers.user_id), never to whichever CRM row shares a phone (Ruling B2B-2e).
          userId: customer.isGuest ? null : customer.id,
          phone: customer.phone || null,
          email: customer.email || null,
          firstName: customer.firstName || null,
          lastName: customer.lastName || null,
          groupId,
        }
      );
      if (apiError) {
        setCustomer(c => (c ? { ...c, ...prev } : c));
        setGroupError(apiError.message || t('groupAssignFailed'));
      }
      setSavingGroup(false);
    },
    [customer, groups, storeId, t]
  );

  /**
   * Merchant-initiated export — same blob-download pattern as the
   * customers-list `.xlsx` export (`page.tsx` one level up), but the
   * response here is JSON (`AuthService.exportAccount`, same shape as the
   * shopper's own `/auth/me/export`).
   */
  const handleExportData = useCallback(async () => {
    if (!storeId || !customer || isExportingData) return;
    setIsExportingData(true);
    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/customers/${customer.id}/export`);
      if (!res.ok) {
        toastError(tPrivacy('exportFailed'));
        return;
      }
      const blob = await res.blob();
      const filename = (() => {
        const cd = res.headers.get('content-disposition') ?? '';
        const match = cd.match(/filename="?([^"]+)"?/i);
        return match?.[1] ?? `customer-${customer.id}.json`;
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
      toastError(tPrivacy('exportFailed'));
    } finally {
      setIsExportingData(false);
    }
  }, [storeId, customer, isExportingData, tPrivacy, toastError]);

  const handleEraseConfirm = useCallback(async () => {
    if (!storeId || !customer) return;
    setIsErasing(true);
    try {
      const { data, error: apiError } = await apiPost<{
        crmReviewNeeded?: boolean;
        crmChecked?: boolean;
        crmRowsScrubbed?: number;
      }>(`/api/v1/stores/${storeId}/customers/${customer.id}/erase`, {});
      if (apiError) {
        toastError(tPrivacy('eraseFailed'), apiError.message ?? '');
        setIsErasing(false);
        return;
      }
      // The account is erased either way, but the merchant-CRM copy is
      // matched by email/phone and can be missed or refused as ambiguous —
      // say so instead of an unqualified success (#1880).
      // An ambiguous CRM match leaves a record the merchant must delete by
      // hand. A 5s toast followed by a navigation was the only place that
      // said so (#2229): the toast now stays until dismissed, and the list we
      // navigate to carries the same instruction as a banner.
      if (data?.crmReviewNeeded) {
        addToast({
          type: 'warning',
          title: tPrivacy('erasedCrmReviewTitle'),
          message: tPrivacy('erasedCrmAmbiguous'),
          duration: 0,
        });
      } else if (data?.crmChecked && data.crmRowsScrubbed === 0) {
        toastSuccess(tPrivacy('erasedToastTitle'), tPrivacy('erasedCrmNotMatched'));
      } else {
        toastSuccess(tPrivacy('erasedToastTitle'), tPrivacy('erasedToastDescription'));
      }
      setShowEraseModal(false);
      // Do NOT re-fetch: the GET route matches a customer only by
      // customerId or shippingAddress.email/phone, and eraseAccount just
      // nulled/scrubbed all three — so a re-fetch 404s every time,
      // surfacing an error banner over the stale pre-erase PII still in
      // state (audit-followup #1872). Navigate back to the list instead.
      router.push(
        `/stores/${storeId}/customers${data?.crmReviewNeeded ? `?${ERASURE_REVIEW_PARAM}=1` : ''}`
      );
    } catch (err) {
      toastError(tPrivacy('eraseFailed'), err instanceof Error ? err.message : '');
    } finally {
      setIsErasing(false);
    }
  }, [storeId, customer, tPrivacy, toastError, toastSuccess, addToast, router]);

  const displayName =
    customer && (customer.firstName || customer.lastName)
      ? `${customer.firstName} ${customer.lastName}`.trim()
      : customer?.email || customer?.phone || t('displayFallback');

  // Inactive groups are hidden from the picker (schema convention) — but if
  // this customer is already in one, keep it selectable so it still displays.
  const activeGroups = groups.filter(g => g.isActive);
  const groupOptions =
    customer?.group && !activeGroups.some(g => g.id === customer.group!.id)
      ? [...activeGroups, { ...customer.group, isActive: false }]
      : activeGroups;

  const orderColumns: DataTableColumn<OrderRow>[] = [
    {
      header: t('colOrderNum'),
      primaryOnMobile: true,
      cell: order => (
        <span className="text-sm font-medium text-foreground">
          {order.orderNumber || order.id.slice(0, 8)}
        </span>
      ),
    },
    {
      header: t('colDate'),
      cell: order => (
        <span className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</span>
      ),
    },
    {
      header: t('colStatus'),
      mobileBadge: true,
      cell: order => <StatusChip status={order.status} />,
    },
    {
      header: t('colPayment'),
      // NOT mobileBadge (issue #1930): the cell below carries the refund
      // amount/provider/date/reason as free text, sometimes several lines.
      // DataTable renders every mobileBadge column inside a `shrink-0` slot
      // in the card's title row — a slot that cannot shrink below content
      // width — and colStatus already occupies that slot on its own, so a
      // second mobileBadge column here doubled up two wedged, unreadable
      // blocks in the top-right corner and let the refund text overflow the
      // card. Left as a normal column, it renders as a full-width label/
      // value row that wraps correctly instead.
      cell: order => {
        // Find the refund payment (most-recent payment row with a non-zero
        // refundedAmount). Refund metadata travels on the Payment row, not
        // the Order, so it's surfaced here as an extra line rather than the
        // original separate full-width banner row — DataTable renders one
        // cell per column, so the refund detail now lives alongside the
        // payment status it explains instead of below it.
        const refundedPayment = order.payments.find(
          p => (p.refundedAmount ?? 0) > 0 || p.status === 'refunded'
        );
        return (
          <div>
            <div className="flex items-center gap-2">
              <StatusChip status={order.paymentStatus} />
              {order.payments[0] && (
                <span className="text-xs text-muted-foreground">
                  {t('via')} {order.payments[0].provider}
                </span>
              )}
            </div>
            {refundedPayment && (
              <p className="mt-1 text-xs text-destructive-ink">
                <span className="font-semibold">{t('refunded')}</span>
                {' · '}-{formatMajor(refundedPayment.refundedAmount ?? order.total)} {t('via')}{' '}
                {refundedPayment.provider}
                {refundedPayment.metadata?.refundedAt && (
                  <>
                    {' '}
                    {t('refundedOn')} {formatDate(refundedPayment.metadata.refundedAt)}
                  </>
                )}
                {refundedPayment.metadata?.refundReason && (
                  <>
                    {' · '}
                    {t('refundedReason')} <em>{refundedPayment.metadata.refundReason}</em>
                  </>
                )}
              </p>
            )}
          </div>
        );
      },
    },
    {
      header: t('colItems'),
      hideOnMobile: true,
      className: 'hidden md:table-cell',
      cell: order => (
        <span className="text-sm text-muted-foreground">
          {order.items.length}{' '}
          <span className="text-xs">
            ({order.items.reduce((sum, it) => sum + it.quantity, 0)} {t('units')})
          </span>
        </span>
      ),
    },
    {
      header: t('colTotal'),
      alignEnd: true,
      cell: order => (
        <span className="text-sm font-bold text-foreground">{formatMajor(order.total)}</span>
      ),
    },
    {
      header: t('colAction'),
      alignEnd: true,
      mobileActions: true,
      cell: order => (
        <Link
          href={`/stores/${storeId}/orders/${order.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1' })}
        >
          {t('viewOrder')}
        </Link>
      ),
    },
  ];

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
          <div className="h-32 animate-pulse rounded-md bg-muted" />
          <div className="h-48 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        // Always render the error banner when present; then render partial
        // data if customer loaded (e.g. a paginated expansion failed after
        // the first page succeeded). `!customer` stays null-guarded below.
        <>
          {error && (
            <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive-ink">
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
                <div className="rounded-md border bg-card p-6 shadow-sm">
                  <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('contactSection')}
                  </h2>
                  <dl className="space-y-3 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">{t('fieldName')}</dt>
                      <dd className="font-medium text-foreground text-end">
                        {customer.firstName} {customer.lastName}
                        {customer.isGuest && (
                          <span className="ms-2 inline-flex items-center rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
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
                    {/* Group assignment — any customer with a phone or email
                        (grouping keys on contact identity, not account status). */}
                    {canGroup && (
                      <div className="flex items-center justify-between gap-4">
                        <dt className="text-muted-foreground">{t('fieldGroup')}</dt>
                        <dd className="text-end">
                          <select
                            value={customer.groupId ?? ''}
                            disabled={savingGroup}
                            onChange={e => assignGroup(e.target.value || null)}
                            className={FIELD_CLASSES}
                          >
                            <option value="">{t('groupNone')}</option>
                            {groupOptions.map(g => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                                {g.nameAr ? ` · ${g.nameAr}` : ''}
                                {!g.isActive ? ` (${t('groupInactive')})` : ''}
                              </option>
                            ))}
                          </select>
                        </dd>
                      </div>
                    )}
                    {groupError && (
                      <p className="text-end text-xs text-destructive-ink">{groupError}</p>
                    )}
                    {/* B2B: which prices this customer actually pays. Group prices are bound to the registered account
                        (customers.user_id), never to a guest's typed phone or email. */}
                    {(() => {
                      const g = groupOptions.find(o => o.id === customer.groupId);
                      if (!g || !g.isActive || (!g.isWholesale && g.pricingMode !== 'percent_off'))
                        return null;
                      return (
                        <p
                          className="text-end text-xs text-muted-foreground"
                          data-testid="customer-price-source"
                        >
                          {customer.isGuest
                            ? t('priceSourceGuest')
                            : t('priceSourceGroup', { name: g.name })}
                        </p>
                      );
                    })()}
                    {/* SMS offers consent (issue 206): status, when and where it
                        was given or withdrawn. Read-only — only the shopper
                        can give consent. */}
                    <div
                      className="flex items-baseline justify-between gap-4"
                      data-sms-consent-status={smsConsent?.status ?? 'none'}
                    >
                      <dt className="text-muted-foreground">{t('fieldSmsConsent')}</dt>
                      <dd className="text-end text-sm">
                        {smsConsent?.status === 'granted' ? (
                          <>
                            <span className="font-medium text-success-ink">
                              {t('smsConsentGranted')}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDate(smsConsent.grantedAt)}
                              {smsConsent.grantedSource
                                ? ` · ${t(`smsConsentSource.${smsConsent.grantedSource}`)}`
                                : ''}
                              {smsConsent.phone ? (
                                <span dir="ltr">{` · ${smsConsent.phone}`}</span>
                              ) : null}
                            </span>
                          </>
                        ) : smsConsent?.status === 'revoked' ? (
                          <>
                            <span className="font-medium text-foreground">
                              {t('smsConsentRevoked')}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDate(smsConsent.revokedAt)}
                              {smsConsent.revokedSource
                                ? ` · ${t(`smsConsentSource.${smsConsent.revokedSource}`)}`
                                : ''}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">{t('smsConsentNone')}</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-md border bg-card p-6 shadow-sm">
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
                <div className="rounded-md border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsOrders')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{customer.totalOrders}</p>
                </div>
                <div className="rounded-md border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsSpent')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatMajor(customer.totalSpent)}
                  </p>
                </div>
                <div className="rounded-md border bg-card p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {t('statsAvgOrder')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatMajor(customer.avgOrderValue)}
                  </p>
                </div>
                <div className="rounded-md border bg-card p-4">
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
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success-ink">
                    {t('statusPaid')} · {customer.paidCount}
                  </span>
                )}
                {customer.pendingCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-3 py-1 text-xs font-medium text-warning-ink">
                    {t('statusPending')} · {customer.pendingCount}
                  </span>
                )}
                {customer.cancelledCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive-ink">
                    {t('statusCancelled')} · {customer.cancelledCount}
                  </span>
                )}
                {customer.failedCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive-ink">
                    {t('statusFailed')} · {customer.failedCount}
                  </span>
                )}
                {customer.refundedCount > 0 && (
                  <span
                    title={`${t('refunded')}: ${formatMajor(customer.totalRefunded)}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive-ink"
                  >
                    {t('statusRefunded')} · {customer.refundedCount}
                    <span className="text-xs text-destructive-ink">
                      ({formatMajor(customer.totalRefunded)})
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
              <div>
                <h2 className="mb-3 text-sm font-semibold text-foreground">
                  {t('ordersSection', { count: orders.length })}
                </h2>
                <DataTable<OrderRow>
                  ariaLabel={t('ordersSection', { count: orders.length })}
                  columns={orderColumns}
                  rows={orders}
                  rowKey={o => o.id}
                />
              </div>

              {/* Customer wallet (store credit) — registered customers only:
                  a guest has no account to hold a balance. */}
              {walletEnabled && !customer.isGuest && (
                <CustomerWalletCard
                  storeId={storeId}
                  customerId={customer.id}
                  canAdjust={canManagePrivacy}
                  onBalance={setWalletBalance}
                />
              )}

              {/* Privacy & data — merchant-initiated erasure/export.
                  Registered customers only: a guest has no User row for
                  AuthService.eraseAccount/exportAccount to act on (their
                  PII lives only in order shipping-address snapshots).
                  Role-gated client-side to match the API's authorize()
                  (store_admin/super_admin only — never staff). */}
              {!customer.isGuest && canManagePrivacy && (
                <div className="rounded-md border border-destructive/30 bg-card shadow-sm">
                  <div className="border-b border-destructive/30 bg-destructive/10 p-4">
                    <h2 className="font-semibold text-destructive-ink">
                      {tPrivacy('sectionTitle')}
                    </h2>
                    <p className="text-sm text-destructive-ink">{tPrivacy('sectionSubtitle')}</p>
                  </div>
                  <div className="p-6 space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{tPrivacy('exportTitle')}</p>
                        <p className="text-sm text-muted-foreground">
                          {tPrivacy('exportDescription')}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={handleExportData}
                        isLoading={isExportingData}
                      >
                        {tPrivacy('exportButton')}
                      </Button>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-border pt-4">
                      <div className="flex-1">
                        <p className="font-medium text-foreground">{tPrivacy('eraseTitle')}</p>
                        <p className="text-sm text-muted-foreground">
                          {tPrivacy('eraseDescription')}
                        </p>
                        {walletEnabled && walletBalance > 0 && (
                          <p className="mt-1 text-sm font-medium text-destructive-ink">
                            {tWallet('forfeitWarning', { amount: formatMajor(walletBalance) })}
                          </p>
                        )}
                      </div>
                      <Button variant="destructive" onClick={() => setShowEraseModal(true)}>
                        {tPrivacy('eraseButton')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {customer && (
        <EraseCustomerModal
          isOpen={showEraseModal}
          confirmValue={customer.email || customer.phone || customer.id}
          isErasing={isErasing}
          onClose={() => setShowEraseModal(false)}
          onConfirm={handleEraseConfirm}
        />
      )}
    </AdminLayout>
  );
}
