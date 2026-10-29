'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { apiGet } from '../../../../../../lib/api';
import { ReviewRow } from './_components/ReviewRow';
import {
  bulkAccept,
  cancelJob,
  createDrafts,
  getJob,
  listItems,
  openSource,
  patchItem,
  publish,
  retryFile,
  type JobDetail,
  type ReviewItem,
} from '../_lib/api';

const TABS = ['pending', 'accepted', 'rejected', 'created'] as const;
type Tab = (typeof TABS)[number];
const RUNNING = new Set(['queued', 'processing', 'creating']);

export default function CatalogImportReviewPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const jobId = params?.jobId as string;
  const t = useT('bulk.catalogImport');

  const [job, setJob] = useState<JobDetail | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [tab, setTab] = useState<Tab>('pending');
  const [categories, setCategories] = useState<
    Array<{ id: string; name: string; nameAr: string | null }>
  >([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const j = await getJob(storeId, jobId);
    if (j.data) setJob(j.data);
    const l = await listItems(storeId, jobId, tab);
    if (l.data) setItems(l.data.items);
  }, [storeId, jobId, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void apiGet<{ categories?: typeof categories } | typeof categories>(
      `/api/v1/stores/${storeId}/categories`
    ).then(r => {
      const d = r.data;
      const list = Array.isArray(d) ? d : (d?.categories ?? []);
      setCategories(list);
    });
  }, [storeId]);

  const running = job ? RUNNING.has(job.status) : true;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [running, load]);

  const onPatch = useCallback(
    async (id: string, body: object) => {
      const r = await patchItem(storeId, jobId, id, body);
      if (r.error) return r.error.code ?? 'GENERIC';
      if (r.data) {
        setItems(prev =>
          r.data!.status !== tab
            ? prev.filter(i => i.id !== id)
            : prev.map(i => (i.id === id ? r.data! : i))
        );
        void getJob(storeId, jobId).then(j => j.data && setJob(j.data));
      }
      return null;
    },
    [storeId, jobId, tab]
  );

  const counts = job?.itemCounts ?? {};
  const accepted = counts.accepted ?? 0;
  const created = useMemo(() => items.filter(i => i.status === 'created'), [items]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    await fn();
    setBusy(false);
    await load();
  }

  const failedFiles =
    job?.files.filter(f => f.status === 'failed' || f.status === 'skipped_quota') ?? [];

  return (
    <AdminLayout
      title={t('review.pageTitle')}
      subtitle={
        job
          ? t('review.progress', { done: job.filesDone + job.filesFailed, total: job.filesTotal })
          : ''
      }
      actions={
        <Button variant="outline" onClick={() => router.push(`/stores/${storeId}/bulk`)}>
          {t('review.back')}
        </Button>
      }
    >
      {job && running && (
        <div className="mb-4 rounded-xl border bg-card p-4" role="status">
          <p className="text-sm text-foreground">
            {job.status === 'creating' ? t('review.creating') : t('review.processing')}
          </p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={job.filesTotal}
            aria-valuenow={job.filesDone + job.filesFailed}
          >
            <div
              className="h-full bg-primary"
              style={{
                width: `${job.filesTotal ? ((job.filesDone + job.filesFailed) / job.filesTotal) * 100 : 0}%`,
              }}
            />
          </div>
          {job.status === 'processing' && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void run(async () => void (await cancelJob(storeId, jobId)))}
            >
              {t('review.cancel')}
            </Button>
          )}
        </div>
      )}

      {job?.status === 'failed' && (
        <p role="alert" className="mb-4 rounded-xl border bg-card p-4 text-sm text-destructive-ink">
          {job.errorCode && t.has(`errors.${job.errorCode}`)
            ? t(`errors.${job.errorCode}`)
            : t('errors.GENERIC')}
        </p>
      )}

      {failedFiles.length > 0 && (
        <ul className="mb-4 divide-y rounded-xl border bg-card text-sm">
          {failedFiles.map(f => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span dir="auto" className="min-w-0 truncate">
                {f.originalName}
                <span className="ms-2 text-xs text-muted-foreground">
                  {f.status === 'skipped_quota' ? t('review.fileWaiting') : t('review.fileFailed')}
                  {f.errorCode && t.has(`errors.${f.errorCode}`)
                    ? ` · ${t(`errors.${f.errorCode}`)}`
                    : ''}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void run(async () => void (await retryFile(storeId, jobId, f.id)))}
              >
                {t('review.retry')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div role="tablist" aria-label={t('review.tabsAria')} className="mb-4 flex gap-4 border-b">
        {TABS.map(x => (
          <button
            key={x}
            role="tab"
            aria-selected={tab === x}
            onClick={() => setTab(x)}
            className={`pb-3 text-sm font-medium max-sm:min-h-11 ${tab === x ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t(`review.tab.${x}`)} <span className="tabular-nums">({counts[x] ?? 0})</span>
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="mb-3 text-sm text-foreground">
          {notice}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
          {running ? t('review.waiting') : t('review.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map(item => (
            <div key={item.id} className="flex items-start gap-2">
              {tab === 'created' && (
                <input
                  type="checkbox"
                  aria-label={t('review.selectDraft')}
                  className="mt-5 h-4 w-4"
                  checked={selected.has(item.id)}
                  onChange={e => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    setSelected(next);
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <ReviewRow
                  item={item}
                  categories={categories}
                  onPatch={onPatch}
                  onOpenSource={fileId => void openSource(storeId, jobId, fileId)}
                  locked={job?.status === 'creating'}
                />
              </div>
            </div>
          ))}
        </ul>
      )}

      <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-2 border-t bg-background py-3">
        {tab === 'pending' && (
          <Button
            variant="outline"
            disabled={busy || running}
            onClick={() =>
              void run(async () => {
                const r = await bulkAccept(storeId, jobId);
                setNotice(t('review.bulkAccepted', { count: r.data?.accepted ?? 0 }));
              })
            }
          >
            {t('review.acceptHigh')}
          </Button>
        )}
        <Button
          disabled={busy || running || accepted === 0}
          onClick={() =>
            void run(async () => {
              const r = await createDrafts(storeId, jobId);
              if (r.error) setNotice(t('errors.GENERIC'));
            })
          }
        >
          {t('review.createDrafts', { count: accepted })}
        </Button>
        {tab === 'created' && (
          <>
            <Button
              variant="outline"
              disabled={busy || selected.size === 0}
              onClick={() =>
                void run(async () => {
                  const r = await publish(storeId, jobId, [...selected]);
                  if (r.data) {
                    setNotice(
                      t('review.published', {
                        published: r.data.published,
                        refused: r.data.refused.length,
                      })
                    );
                    setSelected(new Set());
                  } else setNotice(t('errors.GENERIC'));
                })
              }
            >
              {t('review.publishSelected', { count: selected.size })}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t('review.draftsHidden', { count: created.length })}
            </span>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
