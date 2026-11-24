'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { formatPrice } from '../../../../lib/format';

interface FeeHint {
  status: 'ok' | 'insufficient';
  suggestion: {
    thresholdMinor: number;
    rate: number;
    baselineRate: number;
    n: number;
    scope: 'store' | 'cohort';
  } | null;
}
interface Overview {
  hintsEnabled: boolean;
  ciSharing: boolean;
  gates: Array<{ feature: string; enabled: boolean }>;
  fee: FeeHint | null;
  /** Features paused for THIS store because its own hints were off (Ruling CI-13). */
  pausedForStore: Array<{
    feature: string;
    band: string;
    predictedRate: number;
    actualRate: number;
    resolved: number;
  }>;
  aggregates: { storeAsOf: string | null; cohortAsOf: string | null };
  shown30d: Array<{ feature: string; band: string; count: number }>;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

function Switch({
  checked,
  onChange,
  label,
  busy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border border-border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      {/* Logical offset (start-*), so the knob travels the right way in RTL without direction hacks. */}
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-background shadow transition-[inset-inline-start] motion-reduce:transition-none ${
          checked ? 'start-6' : 'start-1'
        }`}
      />
    </button>
  );
}

/**
 * Smart hints (Customer Intelligence, CI-3, Ruling CI-10). The merchant's own switches (hints, sharing),
 * what the data currently supports, and the shipping-fee suggestion card. Every number shows how many
 * orders it rests on; below the thresholds the page says "not enough data yet", never a guess.
 */
export default function CustomerIntelligencePage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('customerIntelligence');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<'hints' | 'sharing' | null>(null);
  const [saveError, setSaveError] = useState(false);

  const load = useCallback(async () => {
    const { data: d, error: e } = await apiGet<Overview>(`/api/v1/stores/${storeId}/ci/overview`);
    setError(!!e || !d);
    if (d) setData(d);
  }, [storeId]);
  useEffect(() => {
    if (storeId) void load();
  }, [storeId, load]);

  async function toggle(kind: 'hints' | 'sharing', v: boolean) {
    setBusy(kind);
    setSaveError(false);
    const { error: e } = await apiPut(
      `/api/v1/stores/${storeId}/ci/${kind}`,
      kind === 'hints' ? { enabled: v } : { ciSharing: v }
    );
    setBusy(null);
    if (e) setSaveError(true);
    else await load();
  }

  const money = (minor: number) => formatPrice(minor, { locale });

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {error ? (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}{' '}
          <button type="button" className="font-medium underline" onClick={load}>
            {t('retry')}
          </button>
        </p>
      ) : !data ? (
        <div className="space-y-4" aria-busy="true">
          <div className="h-24 animate-pulse rounded-md bg-muted" />
          <div className="h-24 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <div className="max-w-3xl space-y-5">
          {saveError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {t('saveFailed')}
            </p>
          )}

          <section className="rounded-md border bg-card p-5" aria-labelledby="ci-hints">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="ci-hints" className="text-base font-semibold text-foreground">
                  {t('hints.title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('hints.body')}</p>
              </div>
              <Switch
                checked={data.hintsEnabled}
                busy={busy === 'hints'}
                label={t('hints.title')}
                onChange={v => toggle('hints', v)}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {data.hintsEnabled ? t('hints.on') : t('hints.off')}
            </p>
          </section>

          <section className="rounded-md border bg-card p-5" aria-labelledby="ci-sharing">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id="ci-sharing" className="text-base font-semibold text-foreground">
                  {t('sharing.title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('sharing.body')}</p>
              </div>
              <Switch
                checked={data.ciSharing}
                busy={busy === 'sharing'}
                label={t('sharing.title')}
                onChange={v => toggle('sharing', v)}
              />
            </div>
          </section>

          {data.hintsEnabled && (
            <>
              <section className="rounded-md border bg-card p-5" aria-labelledby="ci-fee">
                <h2 id="ci-fee" className="text-base font-semibold text-foreground">
                  {t('fee.title')}
                </h2>
                {data.fee?.suggestion ? (
                  <p className="mt-2 text-sm text-foreground">
                    {t('fee.suggestion', {
                      amount: money(data.fee.suggestion.thresholdMinor),
                      rate: pct(data.fee.suggestion.rate),
                      base: pct(data.fee.suggestion.baselineRate),
                      n: data.fee.suggestion.n,
                    })}
                  </p>
                ) : data.fee && data.fee.status === 'ok' ? (
                  <p className="mt-2 text-sm text-muted-foreground">{t('fee.none')}</p>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">{t('notEnough')}</p>
                )}
              </section>

              {data.pausedForStore.length > 0 && (
                <section className="rounded-md border bg-card p-5" aria-labelledby="ci-paused">
                  <h2 id="ci-paused" className="text-base font-semibold text-foreground">
                    {t('paused.title')}
                  </h2>
                  <ul className="mt-2 space-y-1 text-sm text-foreground">
                    {data.pausedForStore.map(p => (
                      <li key={p.feature}>
                        {t('paused.item', {
                          feature: t(`shown.features.${p.feature}`),
                          predicted: pct(p.predictedRate),
                          actual: pct(p.actualRate),
                          resolved: p.resolved,
                        })}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="rounded-md border bg-card p-5" aria-labelledby="ci-status">
                <h2 id="ci-status" className="text-base font-semibold text-foreground">
                  {t('status.title')}
                </h2>
                <dl className="mt-2 space-y-1 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('status.store')}</dt>
                    <dd dir="ltr" className="tabular-nums">
                      {data.aggregates.storeAsOf ?? t('status.none')}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t('status.cohort')}</dt>
                    <dd dir="ltr" className="tabular-nums">
                      {data.aggregates.cohortAsOf ?? t('status.none')}
                    </dd>
                  </div>
                </dl>
                {data.shown30d.length > 0 && (
                  <>
                    <h3 className="mt-4 text-sm font-medium text-foreground">{t('shown.title')}</h3>
                    <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                      {data.shown30d.map(r => (
                        <li key={`${r.feature}:${r.band}`} className="flex justify-between gap-3">
                          <span>
                            {t(`shown.features.${r.feature}`)} · {t(`bands.${r.band}`)}
                          </span>
                          <span className="tabular-nums">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            </>
          )}

          <p className="text-xs text-muted-foreground">{t('footnote')}</p>
        </div>
      )}
    </AdminLayout>
  );
}
