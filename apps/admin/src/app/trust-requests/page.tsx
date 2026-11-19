'use client';

/**
 * Super-admin trust requests - /trust-requests.
 *
 * Every request a merchant files with Ebda staff lands here: support requests, suspension appeals, protected-address
 * claims and store-limit requests. Filter by kind, status, store and created date; open one to read it in full; RESOLVE
 * (staff acted) or REJECT (declined) it. Each decision is audited server-side (MFA + super_admin). Reactivating a store
 * or granting a protected address also closes the matching request on its own.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
import { cn } from '@ebda/ui/cn';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';

const KINDS = ['support', 'suspension_appeal', 'slug_claim', 'store_cap'] as const;
const STATUSES = ['open', 'resolved', 'rejected'] as const;
type Kind = (typeof KINDS)[number];
type Status = (typeof STATUSES)[number];

interface TrustRow {
  id: string;
  kind: Kind;
  status: Status;
  storeId: string | null;
  userId: string | null;
  topic: string | null;
  message: string | null;
  pageUrl: string | null;
  slug: string | null;
  evidenceUrl: string | null;
  createdAt: string;
}
interface Filters {
  kind: '' | Kind;
  status: '' | Status;
  storeId: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { kind: '', status: 'open', storeId: '', from: '', to: '' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const query = (f: Filters, cursor?: string) => {
  const p = new URLSearchParams();
  if (f.kind) p.set('kind', f.kind);
  if (f.status) p.set('status', f.status);
  if (UUID.test(f.storeId.trim())) p.set('storeId', f.storeId.trim());
  if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) p.set('to', new Date(`${f.to}T23:59:59`).toISOString());
  if (cursor) p.set('cursor', cursor);
  return p.toString();
};

function Inner() {
  const t = useT('trustRequests');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<TrustRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrustRow | null>(null);
  const [working, setWorking] = useState(false);
  const [decisionError, setDecisionError] = useState(false);
  // store-limit requests: RESOLVE carries the new limit (the API checks it is above the current one, at most 20)
  const [limit, setLimit] = useState('4');

  const load = useCallback(
    async (cursor?: string) => {
      setMore(Boolean(cursor));
      const r = await apiGet<{ rows: TrustRow[]; nextCursor: string | null }>(
        `/api/v1/admin/trust-requests?${query(filters, cursor)}`
      );
      setMore(false);
      if (r.error || !r.data) return setError(true);
      setError(false);
      setRows(prev => [...(cursor ? (prev ?? []) : []), ...r.data!.rows]);
      setNext(r.data.nextCursor);
    },
    [filters]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setLimit('4');
    setDecisionError(false);
    const r = await apiGet<{ request: TrustRow }>(`/api/v1/admin/trust-requests/${id}`);
    if (r.error || !r.data) return setDecisionError(true);
    setDetail(r.data.request);
  };

  const decide = async (action: 'resolve' | 'reject') => {
    if (!detail) return;
    setWorking(true);
    setDecisionError(false);
    const grant = action === 'resolve' && detail.kind === 'store_cap';
    const r = await apiPost(
      `/api/v1/admin/trust-requests/${detail.id}/${action}`,
      grant ? { limit: Number(limit) } : undefined
    );
    setWorking(false);
    if (r.error) return setDecisionError(true);
    setOpenId(null);
    setDetail(null);
    await load();
  };

  const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters(f => ({ ...f, [k]: v }));

  return (
    <div className="max-w-5xl space-y-6">
      <section aria-labelledby="tr-filters" className="rounded-xl border bg-card p-4">
        <h2 id="tr-filters" className="sr-only">
          {t('filter.title')}
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filter.kind')}
            <select
              className={FIELD_CLASSES}
              value={filters.kind}
              onChange={e => set('kind', e.target.value as Filters['kind'])}
            >
              <option value="">{t('filter.all')}</option>
              {KINDS.map(k => (
                <option key={k} value={k}>
                  {t(`kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filter.status')}
            <select
              className={FIELD_CLASSES}
              value={filters.status}
              onChange={e => set('status', e.target.value as Filters['status'])}
            >
              <option value="">{t('filter.all')}</option>
              {STATUSES.map(s => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filter.store')}
            <input
              className={cn(FIELD_CLASSES, 'w-72')}
              dir="ltr"
              placeholder={t('filter.storePlaceholder')}
              value={filters.storeId}
              onChange={e => set('storeId', e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filter.from')}
            <input
              type="date"
              className={FIELD_CLASSES}
              value={filters.from}
              max={filters.to || undefined}
              onChange={e => set('from', e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('filter.to')}
            <input
              type="date"
              className={FIELD_CLASSES}
              value={filters.to}
              min={filters.from || undefined}
              onChange={e => set('to', e.target.value)}
            />
          </label>
        </div>
      </section>

      <section aria-labelledby="tr-list" className="rounded-xl border bg-card p-4">
        <h2 id="tr-list" className="text-base font-semibold text-foreground">
          {t('list.title')}
        </h2>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive-ink">
            {t('loadFailed')}
          </p>
        ) : rows === null ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('loading')}</p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  {(['kind', 'status', 'store', 'summary', 'created'] as const).map(c => (
                    <th key={c} scope="col" className="py-1 pe-3 text-start font-medium">
                      {t(`col.${c}`)}
                    </th>
                  ))}
                  <th scope="col" className="py-1 text-start font-medium">
                    <span className="sr-only">{t('col.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="py-1.5 pe-3">{t(`kind.${r.kind}`)}</td>
                    <td className="pe-3">{t(`status.${r.status}`)}</td>
                    <td className="pe-3 text-xs text-muted-foreground" dir="ltr">
                      {r.storeId ?? '—'}
                    </td>
                    <td className="pe-3">
                      {r.topic ? `${r.topic}: ` : ''}
                      {r.slug ? `${r.slug}: ` : ''}
                      {(r.message ?? '').slice(0, 80)}
                    </td>
                    <td className="pe-3 text-xs text-muted-foreground" dir="ltr">
                      {when(r.createdAt)}
                    </td>
                    <td>
                      <Button variant="outline" onClick={() => void open(r.id)}>
                        {t('detail.open')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className="mt-3">
            <Button variant="outline" disabled={more} onClick={() => void load(next)}>
              {t('loadMore')}
            </Button>
          </div>
        )}
      </section>

      {openId && (
        <section aria-labelledby="tr-detail" className="rounded-xl border bg-card p-4">
          <h2 id="tr-detail" className="text-base font-semibold text-foreground">
            {t('detail.title')}
          </h2>
          {!detail ? (
            decisionError ? (
              <p role="alert" className="mt-2 text-sm text-destructive-ink">
                {t('loadFailed')}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t('loading')}</p>
            )
          ) : (
            <>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Item label={t('col.kind')} value={t(`kind.${detail.kind}`)} />
                <Item label={t('col.status')} value={t(`status.${detail.status}`)} />
                <Item label={t('col.store')} value={detail.storeId} ltr />
                <Item label={t('detail.requester')} value={detail.userId} ltr />
                <Item label={t('detail.topic')} value={detail.topic} />
                <Item label={t('detail.slug')} value={detail.slug} ltr />
                <Item label={t('detail.page')} value={detail.pageUrl} ltr />
                <Item label={t('detail.evidence')} value={detail.evidenceUrl} ltr />
                <Item label={t('col.created')} value={when(detail.createdAt)} ltr />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">{t('detail.message')}</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-sm">
                {detail.message ?? '—'}
              </p>
              {decisionError && (
                <p role="alert" className="mt-2 text-sm text-destructive-ink">
                  {t('detail.failed')}
                </p>
              )}
              {detail.status === 'open' && detail.kind === 'store_cap' && (
                <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                  {t('detail.newLimit')}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={3}
                    max={20}
                    step={1}
                    className={cn(FIELD_CLASSES, 'w-28')}
                    value={limit}
                    onChange={e => setLimit(e.target.value)}
                  />
                  <span>{t('detail.newLimitHelp')}</span>
                </label>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {detail.status === 'open' ? (
                  <>
                    <Button disabled={working} onClick={() => void decide('resolve')}>
                      {t('detail.resolve')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={working}
                      onClick={() => void decide('reject')}
                    >
                      {t('detail.reject')}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('detail.decided')}</p>
                )}
                <Button variant="outline" onClick={() => setOpenId(null)}>
                  {t('detail.close')}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Item({ label, value, ltr }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-foreground" dir={ltr ? 'ltr' : undefined}>
        {value || '—'}
      </dd>
    </div>
  );
}

export default function TrustRequestsPage() {
  const t = useT('trustRequests');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <Inner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
