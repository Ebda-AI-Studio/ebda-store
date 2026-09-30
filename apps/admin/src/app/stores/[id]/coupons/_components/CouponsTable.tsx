'use client';

import { useT } from '@/i18n/useT';
import { formatPrice } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { Coupon } from './types';

interface CouponsTableProps {
  coupons: Coupon[];
  onEdit: (coupon: Coupon) => void;
  onDelete: (couponId: string) => void;
  onToggleActive: (couponId: string) => void;
  onCreateFirst: () => void;
}

interface CouponStatus {
  labelKey: 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'active';
  color: string;
}

function getCouponStatus(coupon: Coupon): CouponStatus {
  if (!coupon.isActive) {
    return { labelKey: 'inactive', color: 'bg-muted text-foreground' };
  }

  const now = new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    return {
      labelKey: 'scheduled',
      color: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
    };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return {
      labelKey: 'expired',
      color:
        'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
    };
  }
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
    return {
      labelKey: 'exhausted',
      color: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink',
    };
  }
  return {
    labelKey: 'active',
    color: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  };
}

/**
 * Coupons listing — desktop table, mobile cards. Uses the shared
 * `<DataTable>` so the responsive behaviour matches every other admin
 * list (orders, products, customers, etc.) and a phone-first merchant
 * sees a tappable card stack instead of a horizontally-scrolling table.
 */
export function CouponsTable({
  coupons,
  onEdit,
  onDelete,
  onToggleActive,
  onCreateFirst,
}: CouponsTableProps) {
  const tTable = useT('coupons.table');
  const tStatus = useT('coupons.status');
  const tType = useT('coupons.type');
  const tEmpty = useT('coupons.empty');
  const tActions = useT('coupons.actions');

  function formatValue(coupon: Coupon): string {
    if (coupon.type === 'percentage') return `${coupon.value}%`;
    if (coupon.type === 'fixed') return formatPrice(coupon.value);
    return tType('freeShipping');
  }

  function typeLabel(coupon: Coupon): string {
    if (coupon.type === 'percentage') return tType('percentage');
    if (coupon.type === 'fixed') return tType('fixed');
    return tType('freeShipping');
  }

  const columns: DataTableColumn<Coupon>[] = [
    {
      header: tTable('code'),
      primaryOnMobile: true,
      cell: coupon => (
        <span className="font-mono text-sm bg-muted px-2 py-1 rounded">{coupon.code}</span>
      ),
    },
    {
      header: tTable('name'),
      cell: coupon => (
        <div>
          <p className="font-medium text-foreground">{coupon.name}</p>
          {coupon.nameAr && (
            <p className="text-sm text-muted-foreground" lang="ar" dir="rtl">
              {coupon.nameAr}
            </p>
          )}
        </div>
      ),
    },
    {
      header: tTable('type'),
      cell: coupon => <span className="text-sm text-muted-foreground">{typeLabel(coupon)}</span>,
    },
    {
      header: tTable('value'),
      cell: coupon => <span className="font-medium text-primary">{formatValue(coupon)}</span>,
    },
    {
      header: tTable('usage'),
      cell: coupon => (
        <span className="text-sm text-muted-foreground">
          {coupon.usageCount}
          {coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}
        </span>
      ),
    },
    {
      header: tTable('status'),
      mobileBadge: true,
      cell: coupon => {
        const status = getCouponStatus(coupon);
        return (
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.color}`}
          >
            {tStatus(status.labelKey)}
          </span>
        );
      },
    },
    {
      header: tTable('actions'),
      alignEnd: true,
      mobileActions: true,
      cell: coupon => (
        <div className="flex items-center gap-2 md:justify-end">
          <button
            type="button"
            onClick={() => onToggleActive(coupon.id)}
            className={`inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              coupon.isActive
                ? 'text-warning-ink hover:bg-warning/10'
                : 'text-success-ink hover:bg-success/5'
            }`}
            title={coupon.isActive ? tActions('deactivate') : tActions('activate')}
            aria-label={coupon.isActive ? tActions('deactivate') : tActions('activate')}
          >
            {coupon.isActive ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={() => onEdit(coupon)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
            title={tActions('edit')}
            aria-label={tActions('edit')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(coupon.id)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-destructive hover:bg-destructive/5"
            title={tActions('delete')}
            aria-label={tActions('delete')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      ),
    },
  ];

  const emptyState = (
    <div className="bg-card rounded-xl border overflow-hidden">
      <div className="force-empty-state px-6">
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
              d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
            />
          </svg>
        </div>
        <p className="font-semibold text-foreground">{tEmpty('title')}</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{tEmpty('description')}</p>
        <button
          type="button"
          onClick={onCreateFirst}
          className="mt-4 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          {tEmpty('createFirst')}
        </button>
      </div>
    </div>
  );

  return (
    <DataTable<Coupon>
      ariaLabel={tTable('ariaLabel')}
      columns={columns}
      rows={coupons}
      rowKey={c => c.id}
      emptyState={emptyState}
    />
  );
}
