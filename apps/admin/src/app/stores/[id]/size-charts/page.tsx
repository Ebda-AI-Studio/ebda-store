'use client';

/**
 * /stores/[id]/size-charts — the store's size charts (B0 Task 9).
 *
 * "Every data has a UI" for `size_charts`: the list (name, shape, unit, how many products and
 * categories use it) plus the grid editor. Products pick a chart in FulfilmentCard, categories in
 * the category form; the storefront shows it in the PDP size-guide dialog and on /size-guide.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { sizeChartName, sizeChartSchema } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiDelete, apiGet, apiPost, apiPut } from '../../../../lib/api';
import {
  EMPTY_SIZE_CHART,
  SizeChartEditor,
  type SizeChartDraft,
} from './_components/SizeChartEditor';

interface StoredSizeChart extends SizeChartDraft {
  id: string;
  _count?: { products: number; categories: number };
}

export default function SizeChartsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('sizeCharts.page');
  const askConfirm = useConfirm();
  const tEditor = useT('sizeCharts.editor');
  const locale = useLocale();
  const lang = locale === 'en' ? 'en' : 'ar';

  const [charts, setCharts] = useState<StoredSizeChart[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null = list only; 'new' = creating; otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SizeChartDraft>(EMPTY_SIZE_CHART);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchCharts = useCallback(async () => {
    const { data, error: apiError } = await apiGet<{ sizeCharts: StoredSizeChart[] }>(
      `/api/v1/stores/${storeId}/size-charts`
    );
    if (apiError) setError(t('loadFailed'));
    else {
      setCharts(data?.sizeCharts ?? []);
      setError(null);
    }
    setLoading(false);
  }, [storeId, t]);

  useEffect(() => {
    void fetchCharts();
  }, [fetchCharts]);

  const openNew = () => {
    setDraft(structuredClone(EMPTY_SIZE_CHART));
    setSaveError(null);
    setEditing('new');
  };

  const openEdit = (c: StoredSizeChart) => {
    setDraft({
      name: c.name,
      nameAr: c.nameAr,
      unit: c.unit,
      columns: c.columns,
      rows: c.rows,
      note: c.note,
      noteAr: c.noteAr,
    });
    setSaveError(null);
    setEditing(c.id);
  };

  const save = async () => {
    const parsed = sizeChartSchema.safeParse(draft);
    if (!parsed.success) {
      const nameIssue = parsed.error.issues.some(i => i.path[0] === 'name');
      setSaveError(nameIssue ? tEditor('errorName') : tEditor('errorInvalid'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    const { error: apiError } =
      editing === 'new'
        ? await apiPost(`/api/v1/stores/${storeId}/size-charts`, parsed.data)
        : await apiPut(`/api/v1/stores/${storeId}/size-charts/${editing}`, parsed.data);
    setSaving(false);
    if (apiError) {
      setSaveError(apiError.message || t('saveFailed'));
      return;
    }
    setEditing(null);
    await fetchCharts();
  };

  const remove = async (c: StoredSizeChart) => {
    const ok = await askConfirm({
      object: t('deleteObject', { name: sizeChartName(c, lang) }),
      consequence: t('deleteConsequence'),
      confirmLabel: t('deleteLabel'),
      tone: 'danger',
    });
    if (!ok) return;
    const { error: apiError } = await apiDelete(`/api/v1/stores/${storeId}/size-charts/${c.id}`);
    if (apiError) {
      setError(apiError.message || t('deleteFailed'));
      return;
    }
    if (editing === c.id) setEditing(null);
    await fetchCharts();
  };

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      mode="store_admin"
      storeId={storeId}
      actions={
        editing === null ? (
          <button
            type="button"
            onClick={openNew}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            {t('addNew')}
          </button>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}

        {editing !== null && (
          <SizeChartEditor
            value={draft}
            onChange={setDraft}
            isNew={editing === 'new'}
            saving={saving}
            error={saveError}
            onSave={() => void save()}
            onCancel={() => setEditing(null)}
          />
        )}

        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : charts.length === 0 ? (
          editing === null && (
            <div className="rounded-md border border-dashed py-12 text-center">
              <p className="text-sm font-medium">{t('emptyTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
            </div>
          )
        ) : (
          <ul className="divide-y rounded-xl border bg-card shadow-sm">
            {charts.map(c => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{sizeChartName(c, lang)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('shape', { columns: c.columns.length, rows: c.rows.length })}
                    {' · '}
                    {c.unit === 'in' ? tEditor('unitIn') : tEditor('unitCm')}
                    {' · '}
                    {t('usedBy', {
                      products: c._count?.products ?? 0,
                      categories: c._count?.categories ?? 0,
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    className="text-primary hover:underline"
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(c)}
                    className="text-destructive-ink hover:underline"
                  >
                    {t('delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminLayout>
  );
}
