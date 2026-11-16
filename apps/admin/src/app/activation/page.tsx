'use client';

/**
 * Super-admin merchant activation - /activation (Ruling ACT-1).
 *
 * Separates onboarding friction from demand and fulfilment: how long each store took from signup to every setup
 * milestone (store created, payment methods, went live, first order, first fulfilled order), whether it needed help at
 * each step, and for a store whose order stopped, the last fact reached. Above the list, the funnel over a signup date
 * range (count + median time per step). Ids and times only: no shopper data exists in this view.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet } from '../../lib/api';
import { useT } from '../../i18n/useT';

const STEPS = [
  'store_created',
  'payment_methods',
  'went_live',
  'first_order',
  'first_fulfilled_order',
] as const;
type Step = (typeof STEPS)[number];

interface StepView {
  step: Step;
  reached: boolean;
  secondsFromSignup: number | null;
  helpNeeded: boolean;
  helpKinds: string[];
}
interface Row {
  storeId: string;
  name: string;
  slug: string;
  status: string;
  firstOrderChannel: string | null;
  steps: StepView[];
  lastFact: { fact: string; at: number } | null;
}
interface FunnelRow {
  step: Step;
  count: number;
  medianSecondsFromSignup: number | null;
  helpStores: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function Inner() {
  const t = useT('activation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [funnel, setFunnel] = useState<{ rows: FunnelRow[]; stores: number; truncated: boolean }>();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);

  const duration = (s: number | null) => {
    if (s == null) return '—';
    if (s < 3600) return t('duration.minutes', { n: Math.max(1, Math.round(s / 60)) });
    if (s < 172_800) return t('duration.hours', { n: Math.round(s / 3600) });
    return t('duration.days', { n: Math.round(s / 86_400) });
  };

  // The default range is set after mount: a render-time Date would differ between server and client.
  useEffect(() => {
    setFrom(day(new Date(Date.now() - 30 * 86_400_000)));
    setTo(day(new Date()));
  }, []);

  const loadFunnel = useCallback(async () => {
    if (!from || !to) return;
    const r = await apiGet<{ rows: FunnelRow[]; stores: number; truncated: boolean }>(
      `/api/v1/admin/ci/activation/funnel?from=${from}&to=${to}`
    );
    if (r.error) setError(true);
    else setFunnel(r.data ?? undefined);
  }, [from, to]);

  const loadPage = useCallback(async (cursor?: string) => {
    setMore(true);
    const q = cursor ? `?cursor=${cursor}` : '';
    const r = await apiGet<{ available: boolean; rows: Row[]; nextCursor: string | null }>(
      `/api/v1/admin/ci/activation${q}`
    );
    setMore(false);
    if (r.error) return setError(true);
    setAvailable(r.data?.available ?? false);
    setRows(prev => [...(cursor ? (prev ?? []) : []), ...(r.data?.rows ?? [])]);
    setNext(r.data?.nextCursor ?? null);
  }, []);

  useEffect(() => {
    void loadFunnel();
  }, [loadFunnel]);
  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive-ink">
        {t('loadFailed')}
      </p>
    );
  }
  if (!available) return <p className="text-sm text-muted-foreground">{t('unavailable')}</p>;

  return (
    <div className="max-w-5xl space-y-6">
      <section aria-labelledby="act-funnel" className="rounded-xl border bg-card p-4">
        <h2 id="act-funnel" className="text-base font-semibold text-foreground">
          {t('funnel.title')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('funnel.body')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('funnel.from')}</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={e => setFrom(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('funnel.to')}</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={e => setTo(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1"
            />
          </label>
        </div>
        {funnel && (
          <>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('funnel.stores', { n: funnel.stores })}
              {funnel.truncated ? ` ${t('funnel.truncated')}` : ''}
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pe-3 text-start font-medium">
                      {t('col.step')}
                    </th>
                    <th scope="col" className="py-1 pe-3 text-start font-medium">
                      {t('funnel.count')}
                    </th>
                    <th scope="col" className="py-1 pe-3 text-start font-medium">
                      {t('funnel.median')}
                    </th>
                    <th scope="col" className="py-1 text-start font-medium">
                      {t('funnel.help')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {funnel.rows.map(r => (
                    <tr key={r.step} className="border-t border-border">
                      <th scope="row" className="py-1.5 pe-3 text-start font-normal">
                        {t(`steps.${r.step}`)}
                      </th>
                      <td className="pe-3">{r.count}</td>
                      <td className="pe-3">{duration(r.medianSecondsFromSignup)}</td>
                      <td>{r.helpStores}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="act-stores" className="rounded-xl border bg-card p-4">
        <h2 id="act-stores" className="text-base font-semibold text-foreground">
          {t('stores.title')}
        </h2>
        {rows === null ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('loading')}</p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="py-1 pe-3 text-start font-medium">
                    {t('col.store')}
                  </th>
                  {STEPS.map(s => (
                    <th key={s} scope="col" className="py-1 pe-3 text-start font-medium">
                      {t(`steps.${s}`)}
                    </th>
                  ))}
                  <th scope="col" className="py-1 text-start font-medium">
                    {t('col.stopped')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.storeId} className="border-t border-border align-top">
                    <th scope="row" className="py-1.5 pe-3 text-start font-normal">
                      <span className="block font-medium text-foreground">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">{r.slug}</span>
                    </th>
                    {r.steps.map(s => (
                      <td key={s.step} className="pe-3">
                        {s.reached ? duration(s.secondsFromSignup) : '—'}
                        {s.step === 'first_order' && r.firstOrderChannel && (
                          <span className="block text-xs text-muted-foreground">
                            {t(`channel.${r.firstOrderChannel}`)}
                          </span>
                        )}
                        {s.helpNeeded && (
                          <span className="block text-xs text-warning-ink">
                            {t('helpNeeded')}: {s.helpKinds.map(k => t(`helpKind.${k}`)).join(', ')}
                          </span>
                        )}
                      </td>
                    ))}
                    <td>{r.lastFact ? t(`fact.${r.lastFact.fact}`) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className="mt-3">
            <Button variant="outline" disabled={more} onClick={() => void loadPage(next)}>
              {t('loadMore')}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function ActivationPage() {
  const t = useT('activation');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <Inner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
