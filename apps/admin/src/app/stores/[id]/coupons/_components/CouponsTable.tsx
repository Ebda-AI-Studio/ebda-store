'use client';

import { useT } from '@/i18n/useT';
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
      color: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
    };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
    return {
      labelKey: 'expired',
      color: 'bg-destructive/10 text-destructive dark:bg-destructive/30/30 dark:text-destructive',
    };
  }
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
    return {
      labelKey: 'exhausted',
      color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    };
  }
  return {
    labelKey: 'active',
    color: 'bg-success/10 text-success dark:bg-success/30 dark:text-success',
  };
}

/**
 * Table listing of coupons with per-row actions (toggle, edit, delete).
 * Renders an empty-state CTA when there are no coupons.
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
    if (coupon.type === 'fixed') return `${(coupon.value / 1000).toFixed(3)} KWD`;
    return tType('freeShipping');
  }

  if (coupons.length === 0) {
    return (
      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="text-center py-12">
          <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-muted-foreground"
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
          <p className="text-muted-foreground">{tEmpty('title')}</p>
          <button onClick={onCreateFirst} className="mt-4 text-primary hover:underline">
            {tEmpty('createFirst')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full" aria-label={tTable('ariaLabel')}>
          <thead className="bg-muted border-b">
            <tr>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('code')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('name')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('type')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('value')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('usage')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('status')}
              </th>
              <th
                scope="col"
                className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                {tTable('actions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {coupons.map(coupon => {
              const status = getCouponStatus(coupon);
              const typeLabel =
                coupon.type === 'percentage'
                  ? tType('percentage')
                  : coupon.type === 'fixed'
                    ? tType('fixed')
                    : tType('freeShipping');
              return (
                <tr key={coupon.id} className="hover:bg-muted">
                  <td className="px-6 py-4">
                    <span className="font-mono text-sm bg-muted px-2 py-1 rounded">
                      {coupon.code}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div>
                      <p className="font-medium text-foreground">{coupon.name}</p>
                      {coupon.nameAr && (
                        <p className="text-sm text-muted-foreground" dir="rtl">
                          {coupon.nameAr}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-muted-foreground">{typeLabel}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="font-medium text-primary">{formatValue(coupon)}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-muted-foreground">
                      {coupon.usageCount}
                      {coupon.usageLimit && ` / ${coupon.usageLimit}`}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.color}`}
                    >
                      {tStatus(status.labelKey)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-end">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => onToggleActive(coupon.id)}
                        className={`p-2 rounded-lg transition-colors ${
                          coupon.isActive
                            ? 'text-amber-600 hover:bg-amber-50'
                            : 'text-success hover:bg-success/5'
                        }`}
                        title={coupon.isActive ? tActions('deactivate') : tActions('activate')}
                      >
                        {coupon.isActive ? (
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
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
                        onClick={() => onEdit(coupon)}
                        className="p-2 text-muted-foreground hover:bg-muted rounded-lg"
                        title={tActions('edit')}
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => onDelete(coupon.id)}
                        className="p-2 text-destructive hover:bg-destructive/5 rounded-lg"
                        title={tActions('delete')}
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
