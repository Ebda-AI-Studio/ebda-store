'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { SearchInput } from '@/components/SearchInput';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';

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

  function toDateStr(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  useEffect(() => {
    if (!storeId) return;
    const resolved = resolveDateRange(period, customRange);
    const from = toDateStr(resolved.startDate);
    const to = toDateStr(resolved.endDate);
    apiGet<AdjustmentRow[]>(`/api/v1/stores/${storeId}/stock-adjustments?from=${from}&to=${to}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setAdjustments(data ?? []);
        }
      })
      .catch(() => setError('Failed to load stock adjustments'));
  }, [storeId, period, customRange]);

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

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
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
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!adjustments && !error && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {adjustments && (
        <div className="max-w-5xl space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => router.push(`/stores/${storeId}/stock/adjustments/new`)}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
            >
              {t('newButton')}
            </button>
          </div>

          {(filteredAdjustments ?? adjustments).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No stock adjustments yet. Create one with the button above.
            </p>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground w-28">
                      {t('number')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground w-32">
                      {t('type')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground w-24">
                      {t('status')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground w-32">
                      {t('date')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                      {t('impact')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(filteredAdjustments ?? adjustments).map(adj => {
                    const isDraft = adj.status === 'draft';
                    const impact = adj.totalValueImpact / 1000;
                    const impactStr = `${impact >= 0 ? '+' : ''}${impact.toFixed(3)}`;
                    return (
                      <tr key={adj.id} className="border-t border-border/40">
                        <td className="px-3 py-2 font-mono text-xs">{adj.adjustmentNumber}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {/* Localized adjustment-type label. */}
                          {t(`types.${adj.type}`)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              isDraft
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-green-100 text-green-800'
                            }`}
                          >
                            {adj.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {new Date(adj.createdAt).toLocaleDateString()}
                        </td>
                        <td
                          className={`px-3 py-2 text-end font-mono text-xs font-semibold ${
                            adj.totalValueImpact < 0 ? 'text-red-600' : 'text-green-700'
                          }`}
                        >
                          {impactStr}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
