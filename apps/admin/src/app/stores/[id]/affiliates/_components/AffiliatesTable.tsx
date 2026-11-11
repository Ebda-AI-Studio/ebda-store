'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import {
  formatFils,
  STATUS_COLORS,
  STATUS_FILTERS,
  type Affiliate,
  type AffiliateStatusAction,
  type Meta,
} from './types';
import { Button } from '@/components/ui/Button';

interface AffiliatesTableProps {
  storeId: string;
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
 * Uses the shared DataTable primitive so it stacks to cards on mobile (<md).
 */
export function AffiliatesTable({
  storeId,
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

  const columns: DataTableColumn<Affiliate>[] = [
    {
      header: t('columns.nameEmail'),
      primaryOnMobile: true,
      cell: affiliate => (
        <div>
          <div className="font-medium text-foreground">{affiliate.name}</div>
          <div className="text-sm text-muted-foreground">{affiliate.email}</div>
        </div>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: affiliate => (
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            STATUS_COLORS[affiliate.status] ?? 'bg-muted text-foreground'
          }`}
        >
          {t(`status.${affiliate.status}`)}
        </span>
      ),
    },
    {
      header: t('columns.referralCode'),
      cell: affiliate => (
        <code className="text-sm bg-muted px-2 py-1 rounded-md font-mono">
          {affiliate.referralCode}
        </code>
      ),
    },
    {
      header: t('columns.totalEarned'),
      alignEnd: true,
      cell: affiliate => (
        <span className="text-success-ink font-medium">
          {formatFils(Number(affiliate.totalEarned))}
        </span>
      ),
    },
    {
      header: t('columns.pendingBalance'),
      alignEnd: true,
      cell: affiliate => (
        <span className="text-primary font-medium">
          {formatFils(Number(affiliate.pendingBalance))}
        </span>
      ),
    },
    {
      header: t('columns.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: affiliate => (
        <>
          {/* View events — always available */}
          <Link
            href={`/stores/${storeId}/affiliates/${affiliate.id}/events`}
            className="min-h-11 inline-flex items-center px-3 py-2 text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
          >
            {t('actions.viewEvents')}
          </Link>
          {affiliate.status === 'pending' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="text-success-ink"
                type="button"
                onClick={() => onStatusAction(affiliate, 'approve')}
                disabled={saving}
              >
                {t('actions.approve')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive-ink"
                type="button"
                onClick={() => onStatusAction(affiliate, 'reject')}
                disabled={saving}
              >
                {t('actions.reject')}
              </Button>
            </>
          )}
          {affiliate.status === 'approved' && (
            <>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => onOpenPayout(affiliate)}
                disabled={saving || Number(affiliate.pendingBalance) <= 0}
              >
                {t('actions.payout')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                type="button"
                onClick={() => onStatusAction(affiliate, 'suspend')}
                disabled={saving}
              >
                {t('actions.suspend')}
              </Button>
            </>
          )}
        </>
      ),
    },
  ];

  const emptyState = (
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
  );

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Status filter pills */}
      <div className="flex flex-wrap gap-2 p-4 bg-muted border-b border-border">
        {STATUS_FILTERS.map(s => (
          <Button
            variant={statusFilter === s ? 'soft' : 'ghost'}
            size="sm"
            type="button"
            key={s}
            onClick={() => onStatusFilterChange(s)}
          >
            {t(`filters.${s}`)}
          </Button>
        ))}
      </div>

      <DataTable
        ariaLabel={t('tableLabel')}
        columns={columns}
        rows={affiliates}
        rowKey={a => a.id}
        emptyState={emptyState}
      />

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
            <Button
              variant="outline"
              type="button"
              onClick={() => onPageChange(p => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('pagination.previous')}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => onPageChange(p => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
            >
              {t('pagination.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
