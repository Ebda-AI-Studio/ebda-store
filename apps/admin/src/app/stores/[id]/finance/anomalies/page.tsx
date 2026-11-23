'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { pickAiText } from '@/lib/ai-text';
import { apiGet, apiPost } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { useRequireFeature } from '@/hooks/useRequireFeature';
import { withNumerals } from '@ebda/shared';

import { Button } from '@/components/ui/Button';
// ─── Types ────────────────────────────────────────────────────────────────────

type AnomalySeverity = 'p0' | 'warning';
type AnomalyMetric = 'margin_drop' | 'cost_spike' | 'revenue_drop' | 'refund_spike';
type AnomalyScope = 'store' | 'category' | 'product';

interface ProfitAnomaly {
  id: string;
  storeId: string;
  scope: AnomalyScope;
  scopeId: string | null;
  metric: AnomalyMetric;
  current7d: number;
  baseline28d: number;
  deltaPercent: number;
  severity: AnomalySeverity;
  explanationEn: string;
  explanationAr: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  detectedAt: string;
}

interface ListMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

type SeverityFilter = 'all' | 'p0' | 'warning';
type AckFilter = 'all' | 'false' | 'true';

// ─── Severity badge ───────────────────────────────────────────────────────────

function SeverityBadge({ severity, t }: { severity: AnomalySeverity; t: (k: string) => string }) {
  if (severity === 'p0') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        {t('severity.p0')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-warning/10 text-warning-ink">
      {t('severity.warning')}
    </span>
  );
}

// ─── Anomaly row ──────────────────────────────────────────────────────────────

function AnomalyRow({
  item,
  onAcknowledge,
  t,
  tc,
}: {
  item: ProfitAnomaly;
  onAcknowledge: (id: string) => void;
  t: (k: string) => string;
  tc: (k: string) => string;
}) {
  const locale = useLocale();
  const [acking, setAcking] = useState(false);

  const deltaSign = item.deltaPercent >= 0 ? '+' : '';
  // `deltaPercent` is persisted as a RATIO (e.g. -0.35 for a 35% drop) by
  // profit-anomaly.service.ts — the AI narration multiplies by 100, so the
  // displayed delta must too, otherwise a real -35% shows as -0.4%.
  const deltaPercentDisplay = item.deltaPercent * 100;
  const metricKey = `metric.${item.metric}` as const;

  async function handleAck() {
    if (acking || item.acknowledged) return;
    setAcking(true);
    await onAcknowledge(item.id);
    setAcking(false);
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      {/* Top row: metric + scope + severity + timestamp */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{t(metricKey)}</span>
            <span className="text-xs text-muted-foreground capitalize">{item.scope}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {new Date(item.detectedAt).toLocaleDateString(undefined, withNumerals())}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SeverityBadge severity={item.severity} t={t} />
          {item.acknowledged && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
              {t('acknowledged')}
            </span>
          )}
        </div>
      </div>

      {/* Numbers */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">{t('current7d')}</p>
          <p className="font-mono font-medium">
            {item.metric === 'revenue_drop'
              ? formatPrice(item.current7d)
              : item.current7d.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('baseline28d')}</p>
          <p className="font-mono font-medium">
            {item.metric === 'revenue_drop'
              ? formatPrice(item.baseline28d)
              : item.baseline28d.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">{t('delta')}</p>
          <p
            className={`font-mono font-medium ${
              item.deltaPercent < 0 ? 'text-red-600' : 'text-green-700'
            }`}
          >
            {deltaSign}
            {deltaPercentDisplay.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* AI explanation */}
      {(() => {
        const x = pickAiText(locale, item.explanationEn, item.explanationAr);
        return (
          <p
            className="text-sm text-muted-foreground leading-relaxed"
            lang={x.lang}
            dir={x.lang === 'ar' ? 'rtl' : 'ltr'}
          >
            {x.text}
          </p>
        );
      })()}

      {/* Acknowledge button */}
      {!item.acknowledged && (
        <Button type="button" onClick={handleAck} disabled={acking} variant="outline" size="sm">
          {acking ? tc('saving') : t('acknowledge')}
        </Button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AnomaliesPage() {
  const { gate } = useRequireFeature('accounting.profit_anomaly');

  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.anomalies');
  const tc = useT('common');

  const [items, setItems] = useState<ProfitAnomaly[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [ackFilter, setAckFilter] = useState<AckFilter>('false');

  const load = useCallback(
    async (page = 1) => {
      if (!storeId) return;
      setLoading(true);
      const qs = new URLSearchParams({
        page: String(page),
        perPage: '20',
        severity: severityFilter,
        acknowledged: ackFilter,
      });
      const { data, error: apiError } = await apiGet<{
        data: ProfitAnomaly[];
        meta: ListMeta;
      }>(`/api/v1/stores/${storeId}/finance/anomalies?${qs}`);
      setLoading(false);
      if (apiError) {
        setError(apiError.message);
        return;
      }
      if (data) {
        setItems(data.data);
        setMeta(data.meta);
      }
    },
    [storeId, severityFilter, ackFilter]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function handleAcknowledge(id: string) {
    const { error: apiError } = await apiPost(
      `/api/v1/stores/${storeId}/finance/anomalies/${id}/acknowledge`,
      {}
    );
    if (!apiError) {
      setItems(prev => prev.map(a => (a.id === id ? { ...a, acknowledged: true } : a)));
    }
  }

  if (gate) return gate;

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-3xl space-y-6">
        {/* Description */}
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          {/* Severity filter */}
          {(['all', 'p0', 'warning'] as SeverityFilter[]).map(sev => (
            <Button
              key={sev}
              type="button"
              onClick={() => setSeverityFilter(sev)}
              variant={severityFilter === sev ? 'soft' : 'ghost'}
              size="sm"
            >
              {sev === 'all'
                ? t('filter.all')
                : sev === 'p0'
                  ? t('filter.p0')
                  : t('severity.warning')}
            </Button>
          ))}
          <span className="border-l border-border mx-1" />
          {/* Acknowledged filter */}
          {(['false', 'all', 'true'] as AckFilter[]).map(ack => (
            <Button
              key={ack}
              type="button"
              onClick={() => setAckFilter(ack)}
              variant={ackFilter === ack ? 'soft' : 'ghost'}
              size="sm"
            >
              {ack === 'false'
                ? t('filter.open')
                : ack === 'all'
                  ? t('filter.all')
                  : t('acknowledged')}
            </Button>
          ))}
        </div>

        {/* Error */}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Loading */}
        {loading && <p className="text-sm text-muted-foreground">{tc('loading')}</p>}

        {/* Empty state */}
        {!loading && !error && items.length === 0 && (
          <div className="rounded-xl border border-border bg-muted/10 p-6 text-center">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        )}

        {/* Rows */}
        {items.length > 0 && (
          <div className="space-y-4">
            {items.map(item => (
              <AnomalyRow
                key={item.id}
                item={item}
                onAcknowledge={handleAcknowledge}
                t={t}
                tc={tc}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Button
              type="button"
              disabled={meta.page === 1}
              onClick={() => load(meta.page - 1)}
              variant="outline"
              size="sm"
            >
              ←
            </Button>
            <span className="text-muted-foreground">
              {meta.page} / {meta.totalPages}
            </span>
            <Button
              type="button"
              disabled={meta.page >= meta.totalPages}
              onClick={() => load(meta.page + 1)}
              variant="outline"
              size="sm"
            >
              →
            </Button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
