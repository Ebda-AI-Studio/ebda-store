'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { Button, buttonVariants } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { AITranslateMissingButton } from '../../../../components/AITranslateMissingButton';
import { DataTable } from '../../../../components/mobile/DataTable';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { tagTranslatePair } from '../../../../lib/tag-translate-pair';

/**
 * Store tags (Phase B3 fix wave 1, Ruling B3-13): the skin-type / concern chips are tags, and each
 * tag has an English label (`name`, also the `?tag=` filter key) and an Arabic label (`nameAr`).
 * The storefront shows the one for the shopper's language and falls back, marked with `lang`.
 * "Translate missing" fills the empty side of every row (the page-level AI pattern).
 */
interface TagRow {
  id: string;
  name: string;
  nameAr: string;
  productCount: number;
}

export default function StoreTagsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('tags.page');
  const { success: toastSuccess, error: toastError } = useToast();
  const [rows, setRows] = useState<TagRow[]>([]);
  const [saved, setSaved] = useState<Record<string, TagRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{
        tags: Array<{ id: string; name: string; nameAr: string | null; productCount: number }>;
      }>(`/api/v1/stores/${storeId}/tags`);
      if (res.error || !res.data) throw new Error('load');
      const list = res.data.tags.map(r => ({ ...r, nameAr: r.nameAr ?? '' }));
      setRows(list);
      setSaved(Object.fromEntries(list.map(r => [r.id, r])));
    } catch {
      setError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, change: Partial<TagRow>) =>
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...change } : r)));

  async function save(row: TagRow) {
    setSavingId(row.id);
    try {
      const res = await apiPut(`/api/v1/stores/${storeId}/tags/${row.id}`, {
        name: row.name.trim(),
        nameAr: row.nameAr.trim() || null,
      });
      if (res.error) {
        toastError(res.error.code === 'TAG_EXISTS' ? t('exists') : t('saveError'));
        return;
      }
      setSaved(prev => ({ ...prev, [row.id]: row }));
      toastSuccess(t('saved'));
    } catch {
      toastError(t('saveError'));
    } finally {
      setSavingId(null);
    }
  }

  const dirty = (r: TagRow) =>
    saved[r.id] && (saved[r.id].name !== r.name || saved[r.id].nameAr !== r.nameAr);

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <div className="flex gap-2">
          <AITranslateMissingButton
            storeId={storeId}
            pairs={rows.map(r => tagTranslatePair(r, patch))}
          />
        </div>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive-ink">
          {error}
        </p>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
          <Link href={`/stores/${storeId}/products`} className={buttonVariants()}>
            {t('emptyAction')}
          </Link>
        </div>
      )}
      {rows.length > 0 && (
        <div className="rounded-xl border bg-card shadow-sm">
          <DataTable
            ariaLabel={t('name')}
            rows={rows}
            rowKey={r => r.id}
            columns={[
              {
                header: t('name'),
                primaryOnMobile: true,
                cell: r => (
                  <input
                    aria-label={t('name')}
                    data-tag-row={r.id}
                    className="h-10 w-full min-w-[10rem] rounded-md border border-input bg-background px-3"
                    value={r.name}
                    maxLength={80}
                    onChange={e => patch(r.id, { name: e.target.value })}
                  />
                ),
              },
              {
                header: t('nameAr'),
                cell: r => (
                  <>
                    <input
                      aria-label={t('nameAr')}
                      dir="rtl"
                      lang="ar"
                      className="h-10 w-full min-w-[10rem] rounded-md border border-input bg-background px-3"
                      value={r.nameAr}
                      maxLength={80}
                      onChange={e => patch(r.id, { nameAr: e.target.value })}
                    />
                    {!r.nameAr.trim() && (
                      <p className="mt-1 text-xs text-muted-foreground">{t('missingAr')}</p>
                    )}
                  </>
                ),
              },
              {
                header: t('products'),
                cell: r => <span className="tabular-nums">{r.productCount}</span>,
              },
              {
                header: '',
                mobileActions: true,
                alignEnd: true,
                cell: r => (
                  <Button
                    type="button"
                    size="sm"
                    disabled={!dirty(r) || !r.name.trim() || savingId === r.id}
                    onClick={() => save(r)}
                  >
                    {t('save')}
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
    </AdminLayout>
  );
}
