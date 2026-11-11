'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { apiGet, apiDelete } from '@/lib/api';
import { RedirectsTable, type SlugRedirectRow } from './RedirectsTable';
import { Button } from '@/components/ui/Button';

// #903: SlugRedirect had no admin UI surface at all — a merchant could not
// see or remove a spuriously-captured bulk-import alias, or a stale
// redirect blocking an old slug being re-purposed for something new. This
// is READ + DELETE only: rows are written exclusively by
// recordSlugRedirect alongside the entity rename that produced them (see
// docs/architecture/slug-redirects.md), so there is no create/edit form.
//
// The list/delete logic lives in RedirectsTable — a pure function of props —
// so it is testable without AdminLayout's context tree; this file owns only
// fetching, the confirm dialog and the layout chrome.

interface SlugRedirectList {
  rows: SlugRedirectRow[];
  total: number;
  limit: number;
  /** Next page's cursor, or null on the last page (issue 2255). */
  nextCursor?: string | null;
}

export default function SlugRedirectsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('seo.page');
  const askConfirm = useConfirm();

  const [list, setList] = useState<SlugRedirectList | null>(null);
  // A failed LOAD has nothing to show; a failed DELETE must not take the
  // table the merchant is working through away with it (scoped audit P3,
  // PR 1978). So the error renders as a banner above the table, never as an
  // early return that unmounts it, and the load error carries a retry.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  // Search-as-you-type: apply 150 ms after the last keystroke (the button still applies at once).
  const liveQuery = useDebouncedValue(query.trim(), 150);
  useEffect(() => setAppliedQuery(liveQuery), [liveQuery]);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    if (!storeId) return;
    setLoadError(null);
    const qs = appliedQuery ? `?q=${encodeURIComponent(appliedQuery)}` : '';
    apiGet<SlugRedirectList>(`/api/v1/stores/${storeId}/slug-redirects${qs}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setLoadError(apiError.message || t('redirectsLoadError'));
        } else {
          setList(data ?? { rows: [], total: 0, limit: 0 });
        }
      })
      .catch(() => setLoadError(t('redirectsLoadError')));
  }, [storeId, appliedQuery, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Issue 2255: the list used to stop at the first 200 rows with no way to
  // reach the rest by browsing. "Load more" appends the next page.
  async function loadMore() {
    if (!list?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    const params = new URLSearchParams({ cursor: list.nextCursor });
    if (appliedQuery) params.set('q', appliedQuery);
    const { data, error: apiError } = await apiGet<SlugRedirectList>(
      `/api/v1/stores/${storeId}/slug-redirects?${params.toString()}`
    );
    setLoadingMore(false);
    if (apiError || !data) {
      setLoadError(apiError?.message || t('redirectsLoadError'));
      return;
    }
    setList(prev =>
      prev
        ? {
            ...data,
            rows: [...prev.rows, ...data.rows.filter(r => !prev.rows.some(p => p.id === r.id))],
          }
        : data
    );
  }

  async function handleDelete(id: string) {
    const ok = await askConfirm({
      object: t('redirectsDeleteObject'),
      consequence: t('redirectsDeleteConsequence'),
      confirmLabel: t('redirectsDeleteLabel'),
      tone: 'danger',
    });
    if (!ok) return;
    setDeletingId(id);
    setActionError(null);
    const { error: apiError } = await apiDelete(`/api/v1/stores/${storeId}/slug-redirects/${id}`);
    setDeletingId(null);
    if (apiError) {
      setActionError(t('redirectsDeleteError'));
      return;
    }
    setList(prev =>
      prev ? { ...prev, rows: prev.rows.filter(row => row.id !== id), total: prev.total - 1 } : prev
    );
  }

  const header = {
    title: t('redirectsTitle'),
    subtitle: t('redirectsSubtitle'),
  };

  return (
    <AdminLayout {...header}>
      <div className="max-w-5xl space-y-4">
        <form
          role="search"
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault();
            setAppliedQuery(query.trim());
          }}
        >
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('redirectsSearchPlaceholder')}
            aria-label={t('redirectsSearchPlaceholder')}
            maxLength={255}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <Button variant="outline" size="md" type="submit">
            {t('redirectsSearch')}
          </Button>
        </form>

        {(loadError || actionError) && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-ink"
          >
            <span>{loadError ?? actionError}</span>
            {loadError ? (
              <button type="button" onClick={load} className="underline">
                {t('redirectsRetry')}
              </button>
            ) : (
              <button type="button" onClick={() => setActionError(null)} className="underline">
                {t('redirectsDismiss')}
              </button>
            )}
          </div>
        )}

        {!list && !loadError && (
          <div className="text-muted-foreground text-sm">{t('redirectsLoading')}</div>
        )}

        {list && (
          <>
            {list.total > list.rows.length && (
              <p className="text-xs text-muted-foreground">
                {t('redirectsShowingOf', { shown: list.rows.length, total: list.total })}
              </p>
            )}
            <RedirectsTable
              rows={list.rows}
              deletingId={deletingId}
              onDelete={handleDelete}
              t={t}
              ariaLabel={t('redirectsTitle')}
            />
            {list.nextCursor && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? t('redirectsLoadingMore') : t('redirectsLoadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
