'use client';

import { useT } from '@/i18n/useT';
import {
  formatFils,
  STATUS_COLORS,
  STATUS_FILTERS,
  type Affiliate,
  type AffiliateStatusAction,
  type Meta,
} from './types';

interface AffiliatesTableProps {
  affiliates: Affiliate[];
  meta: Meta | null;
  statusFilter: string;
  page: number;
  saving: boolean;
  onStatusFilterChange: (status: string) => void;
  onPageChange: (updater: (prev: number) => number) => void;
  onStatusAction: (affiliate: Affiliate, action: AffiliateStatusAction) => void;
  onOpenPayout: (affiliate: Affiliate) => void;
}

/**
 * Affiliates list: status filter pills, table rows with per-row actions
 * (approve/reject/suspend/payout), empty state, and pagination footer.
 */
export function AffiliatesTable({
  affiliates,
  meta,
  statusFilter,
  page,
  saving,
  onStatusFilterChange,
  onPageChange,
  onStatusAction,
  onOpenPayout,
}: AffiliatesTableProps) {
  const t = useT('affiliates.list');

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex flex-wrap gap-2 p-4 bg-muted border-b border-border">
        {STATUS_FILTERS.map(s => (
          <button
            type="button"
            key={s}
            onClick={() => onStatusFilterChange(s)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary text-white'
                : 'bg-card text-foreground hover:bg-muted border border-border'
            }`}
          >
            {t(`filters.${s}`)}
          </button>
        ))}
      </div>

      {affiliates.length === 0 ? (
        <div className="p-12 text-center">
          <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">{t('empty.title')}</h3>
          <p className="text-muted-foreground">{t('empty.description')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full" aria-label={t('tableLabel')}>
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.nameEmail')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.referralCode')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.status')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.totalEarned')}
                  </th>
                  <th
                    scope="col"
                    className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.pendingBalance')}
                  </th>
                  <th
                    scope="col"
                    className="text-end px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                  >
                    {t('columns.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {affiliates.map(affiliate => (
                  <tr key={affiliate.id} className="hover:bg-muted">
                    <td className="px-6 py-4">
                      <div className="font-medium text-foreground">{affiliate.name}</div>
                      <div className="text-sm text-muted-foreground">{affiliate.email}</div>
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
                        {affiliate.referralCode}
                      </code>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          STATUS_COLORS[affiliate.status] ?? 'bg-muted text-foreground'
                        }`}
                      >
                        {t(`status.${affiliate.status}`)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-success font-medium">
                      {formatFils(Number(affiliate.totalEarned))}
                    </td>
                    <td className="px-6 py-4 text-primary font-medium">
                      {formatFils(Number(affiliate.pendingBalance))}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2 flex-wrap">
                        {affiliate.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => onStatusAction(affiliate, 'approve')}
                              disabled={saving}
                              className="text-success hover:text-success text-sm font-medium disabled:opacity-50"
                            >
                              {t('actions.approve')}
                            </button>
                            <button
                              type="button"
                              onClick={() => onStatusAction(affiliate, 'reject')}
                              disabled={saving}
                              className="text-destructive hover:text-destructive text-sm font-medium disabled:opacity-50"
                            >
                              {t('actions.reject')}
                            </button>
                          </>
                        )}
                        {affiliate.status === 'approved' && (
                          <>
                            <button
                              type="button"
                              onClick={() => onOpenPayout(affiliate)}
                              disabled={saving || Number(affiliate.pendingBalance) <= 0}
                              className="text-primary hover:text-primary/90 text-sm font-medium disabled:opacity-30"
                            >
                              {t('actions.payout')}
                            </button>
                            <button
                              type="button"
                              onClick={() => onStatusAction(affiliate, 'suspend')}
                              disabled={saving}
                              className="text-muted-foreground hover:text-foreground text-sm font-medium disabled:opacity-50"
                            >
                              {t('actions.suspend')}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted">
              <p className="text-sm text-muted-foreground">
                {t('pagination.summary', {
                  page: meta.page,
                  totalPages: meta.totalPages,
                  total: meta.total,
                })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onPageChange(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50 hover:bg-card"
                >
                  {t('pagination.previous')}
                </button>
                <button
                  type="button"
                  onClick={() => onPageChange(p => Math.min(meta.totalPages, p + 1))}
                  disabled={page >= meta.totalPages}
                  className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50 hover:bg-card"
                >
                  {t('pagination.next')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
