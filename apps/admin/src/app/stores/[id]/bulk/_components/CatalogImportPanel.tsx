'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { listJobs, uploadFiles, type Allowance, type JobSummary } from '../catalog-import/_lib/api';

const ACTIVE = new Set(['queued', 'processing', 'creating']);

/** Upload tab: pick photos or PDFs, see what is left of this month's allowance, follow past imports. */
export function CatalogImportPanel({ storeId }: { storeId: string }) {
  const t = useT('bulk.catalogImport');
  const inputRef = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await listJobs(storeId);
    if (data) {
      setJobs(data.jobs);
      setAllowance(data.allowance);
    }
    setLoaded(true);
  }, [storeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while something is running; back off, stop when everything is settled.
  const running = jobs.some(j => ACTIVE.has(j.status));
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [running, refresh]);

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    const { error: err } = await uploadFiles(storeId, Array.from(files));
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (err) {
      setError(t.has(`errors.${err.code}`) ? t(`errors.${err.code}`) : t('errors.GENERIC'));
      return;
    }
    await refresh();
  }

  if (loaded && allowance && !allowance.enabled) {
    return (
      <div className="rounded-xl border bg-card p-6" role="status">
        <h3 className="font-semibold text-foreground">{t('upgradeTitle')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('upgradeBody')}</p>
      </div>
    );
  }

  const left =
    allowance?.remainingMonth === null || allowance?.remainingMonth === undefined
      ? null
      : allowance.remainingMonth;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-6">
        <h3 className="font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            id="catalog-files"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
            className="sr-only"
            onChange={e => void onPick(e.target.files)}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? t('uploading') : t('choose')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('limits')}</span>
          {left !== null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('allowance', { count: left })}
            </span>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('privacyNote')}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {error}
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">{t('jobsTitle')}</h3>
        {loaded && jobs.length === 0 ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            {t('noJobs')}
          </p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {jobs.map(j => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium text-foreground">
                    {t('jobLine', { files: j.filesTotal, items: j.itemsTotal })}
                  </span>
                  <span className="ms-2 text-xs text-muted-foreground">
                    {t(`status.${j.status}`)}
                    {j.status === 'failed' && j.errorCode
                      ? ` · ${t.has(`errors.${j.errorCode}`) ? t(`errors.${j.errorCode}`) : t('errors.GENERIC')}`
                      : ''}
                  </span>
                </div>
                {(j.status === 'review' ||
                  j.status === 'done' ||
                  j.status === 'processing' ||
                  j.status === 'creating') && (
                  <Link
                    href={`/stores/${storeId}/bulk/catalog-import/${j.id}`}
                    className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline sm:min-h-0"
                  >
                    {j.status === 'review' ? t('review') : t('open')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
