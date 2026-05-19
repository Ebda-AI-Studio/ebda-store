'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

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

  const [adjustments, setAdjustments] = useState<AdjustmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<AdjustmentRow[]>(`/api/v1/stores/${storeId}/stock-adjustments`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setAdjustments(data ?? []);
        }
      })
      .catch(() => setError('Failed to load stock adjustments'));
  }, [storeId]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!adjustments) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
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

        {adjustments.length === 0 ? (
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
                {adjustments.map(adj => {
                  const isDraft = adj.status === 'draft';
                  const impact = adj.totalValueImpact / 1000;
                  const impactStr = `${impact >= 0 ? '+' : ''}${impact.toFixed(3)}`;
                  return (
                    <tr key={adj.id} className="border-t border-border/40">
                      <td className="px-3 py-2 font-mono text-xs">{adj.adjustmentNumber}</td>
                      <td className="px-3 py-2 text-muted-foreground capitalize">
                        {/* Use the types sub-key; fall back to raw value */}
                        {adj.type.replace(/_/g, ' ')}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                            isDraft ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'
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
    </AdminLayout>
  );
}
