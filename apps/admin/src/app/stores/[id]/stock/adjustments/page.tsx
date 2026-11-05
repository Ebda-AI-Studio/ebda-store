'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { SearchInput } from '@/components/SearchInput';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { Button } from '@ebda/ui';
import { ErrorState } from '@/components/ErrorState';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';
import { reportRangeQueryString, minorToDecimalString, withNumerals } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdjustmentRow {
  id: string;
  adjustmentNumber: string;
  type: string;
  status: 'draft' | 'posted';
  createdAt: string;
  totalValueImpact: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StockAdjustmentsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.adjustments');
  const tc = useT('common');

  const [period, setPeriod] = useState<Period>('last_30');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [adjustments, setAdjustments] = useState<AdjustmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Debounced search term — client-side filter over adjustment number and type.
  const [search, setSearch] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    // Shared report-range contract: the picked days in the viewer's timezone
    // (the date-only from/to were read as UTC days).
    const rangeQs = reportRangeQueryString(resolveDateRange(period, customRange));
    apiGet<AdjustmentRow[]>(`/api/v1/stores/${storeId}/stock-adjustments?${rangeQs}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setAdjustments(data ?? []);
        }
      })
      .catch(() => setError(t('loadFailed')));
  }, [storeId, period, customRange, retryKey]);

  // Client-side filter: match adjustment number or type (case-insensitive).
  const filteredAdjustments = useMemo(() => {
    if (!adjustments) return adjustments;
    if (!search.trim()) return adjustments;
    const q = search.toLowerCase();
    return adjustments.filter(
      adj =>
        adj.adjustmentNumber.toLowerCase().includes(q) ||
        adj.type.replace(/_/g, ' ').toLowerCase().includes(q)
    );
  }, [adjustments, search]);

  const columns: DataTableColumn<AdjustmentRow>[] = [
    {
      header: t('number'),
      primaryOnMobile: true,
      className: 'w-28',
      cell: adj => <span className="font-mono text-xs">{adj.adjustmentNumber}</span>,
    },
    {
      header: t('type'),
      className: 'w-32',
      cell: adj => (
        <span className="text-muted-foreground">
          {/* Localized adjustment-type label. */}
          {t(`types.${adj.type}`)}
        </span>
      ),
    },
    {
      header: t('status'),
      mobileBadge: true,
      className: 'w-24',
      cell: adj => {
        const isDraft = adj.status === 'draft';
        return (
          <span
            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
              isDraft ? 'bg-warning/10 text-warning-ink' : 'bg-green-100 text-green-800'
            }`}
          >
            {adj.status}
          </span>
        );
      },
    },
    {
      header: t('date'),
      className: 'w-32',
      cell: adj => (
        <span className="text-muted-foreground">
          {new Date(adj.createdAt).toLocaleDateString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('impact'),
      alignEnd: true,
      cell: adj => {
        const impactStr = `${adj.totalValueImpact >= 0 ? '+' : ''}${minorToDecimalString(adj.totalValueImpact)}`;
        return (
          <span
            className={`font-mono text-xs font-semibold ${
              adj.totalValueImpact < 0 ? 'text-red-600' : 'text-green-700'
            }`}
          >
            {impactStr}
          </span>
        );
      },
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <Button
          className="min-h-11"
          onClick={() => router.push(`/stores/${storeId}/stock/adjustments/new`)}
        >
          {t('newButton')}
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <DateRangePicker
          period={period}
          custom={customRange}
          onChange={(p, c) => {
            setPeriod(p);
            if (c) setCustomRange(c);
          }}
        />
        <SearchInput
          value={search}
          onSearch={setSearch}
          placeholder={t('searchPlaceholder')}
          className="w-full sm:w-64"
        />
      </div>

      {error && (
        <ErrorState
          message={error}
          onRetry={() => {
            setError(null);
            setRetryKey(k => k + 1);
          }}
        />
      )}

      {!adjustments && !error && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {adjustments && !error && (
        <div className="max-w-5xl space-y-4">
          <DataTable<AdjustmentRow>
            ariaLabel={t('title')}
            columns={columns}
            rows={filteredAdjustments ?? adjustments}
            rowKey={adj => adj.id}
            emptyState={<p className="text-muted-foreground text-sm">{t('emptyState')}</p>}
          />
        </div>
      )}
    </AdminLayout>
  );
}
