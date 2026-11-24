'use client';

/**
 * Super-admin Customer Intelligence - /ci-insights (CI-2 insights, CI-3 kill switches; Rulings CI-9, CI-10).
 *
 * Findings from the cross-store cohort (cells that passed the k-thresholds, so no store or person is
 * named), each with the number of outcomes and stores behind it. A person accepts or dismisses; nothing
 * changes a default by itself. Below, the kill switch per merchant hint (the weekly calibration only
 * alerts: closing a platform gate is a human decision).
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';

interface Insight {
  id: string;
  metric: string;
  cohort: string;
  finding: string;
  findingAr: string;
  evidence: { n: number; stores: number; rate: number; baselineRate: number; asOf: string };
  model: string;
  status: 'new' | 'accepted' | 'dismissed';
  asOf: string;
}
interface Gate {
  feature: string;
  enabled: boolean;
  reason: string | null;
  at: string | null;
}

const STATUSES = ['new', 'accepted', 'dismissed'] as const;

function Inner() {
  const t = useT('ciInsights');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('new');
  const [rows, setRows] = useState<Insight[] | null>(null);
  const [gates, setGates] = useState<Gate[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, g] = await Promise.all([
      apiGet<{ insights: Insight[] }>(`/api/v1/admin/ci/insights?status=${status}`),
      apiGet<{ gates: Gate[] }>('/api/v1/admin/ci/gates'),
    ]);
    setError(!!i.error || !!g.error);
    setRows(i.data?.insights ?? []);
    setGates(g.data?.gates ?? []);
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, s: 'accepted' | 'dismissed') => {
    setBusy(id);
    await apiPut(`/api/v1/admin/ci/insights/${id}`, { status: s });
    setBusy(null);
    await load();
  };
  const setGate = async (feature: string, enabled: boolean) => {
    setBusy(feature);
    await apiPut(`/api/v1/admin/ci/gates/${feature}`, { enabled });
    setBusy(null);
    await load();
  };

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive-ink">
        {t('loadFailed')}
      </p>
    );
  }
  return (
    <div className="max-w-3xl space-y-6">
      <div role="tablist" aria-label={t('filter')} className="flex gap-2">
        {STATUSES.map(s => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-sm ${
              status === s ? 'border-primary bg-primary/10 font-medium' : 'border-border'
            }`}
          >
            {t(`status.${s}`)}
          </button>
        ))}
      </div>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map(r => (
            <li key={r.id} className="rounded-md border bg-card p-4">
              <p className="text-sm text-foreground">{locale === 'ar' ? r.findingAr : r.finding}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('evidence', {
                  n: r.evidence.n,
                  stores: r.evidence.stores,
                  date: r.evidence.asOf,
                })}
              </p>
              {r.status === 'new' && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={busy === r.id} onClick={() => decide(r.id, 'accepted')}>
                    {t('accept')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy === r.id}
                    onClick={() => decide(r.id, 'dismissed')}
                  >
                    {t('dismiss')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="ci-gates" className="rounded-md border bg-card p-4">
        <h2 id="ci-gates" className="text-base font-semibold text-foreground">
          {t('gates.title')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('gates.body')}</p>
        <ul className="mt-3 divide-y divide-border">
          {gates.map(g => (
            <li key={g.feature} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {t(`gates.features.${g.feature}`)}
                {!g.enabled && g.reason && (
                  <span className="ms-2 text-xs text-muted-foreground">{g.reason}</span>
                )}
              </span>
              <Button
                variant="outline"
                disabled={busy === g.feature}
                onClick={() => setGate(g.feature, !g.enabled)}
              >
                {g.enabled ? t('gates.close') : t('gates.open')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function CiInsightsPage() {
  const t = useT('ciInsights');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <Inner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
