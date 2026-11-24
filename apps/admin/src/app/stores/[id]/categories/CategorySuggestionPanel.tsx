'use client';

/**
 * "Suggest categories from my products" for a store that has none. The assistant proposes a grouping; the
 * merchant renames, removes, or un-ticks products, then accepts. Nothing exists until "Create", and Create only
 * sends what is on screen (the server re-checks every product id against the store).
 */
import { useState } from 'react';
import { useLocale } from 'next-intl';
import { apiPost } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
interface Proposal {
  categories: Array<{
    name: string;
    nameAr: string;
    products: Array<{ id: string; name: string; nameAr: string | null }>;
  }>;
  unassigned: number;
  sampled: number;
}
interface Draft {
  key: number;
  name: string;
  nameAr: string;
  products: Proposal['categories'][number]['products'];
  off: Set<string>;
}

export function CategorySuggestionPanel({
  storeId,
  onCreated,
}: {
  storeId: string;
  onCreated: () => void;
}) {
  const t = useT('categories.suggest');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [busy, setBusy] = useState<'ask' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [info, setInfo] = useState<{ unassigned: number } | null>(null);
  const base = `/api/v1/stores/${storeId}/ai`;

  const fail = (code?: string) =>
    setError(
      code === 'NO_PRODUCTS'
        ? t('noProducts')
        : code === 'CATEGORIES_EXIST'
          ? t('exist')
          : code === 'AI_DISABLED_BY_MERCHANT'
            ? t('aiOff')
            : code?.startsWith('AI_QUOTA') || code === 'AI_BUDGET_EXCEEDED'
              ? t('quota')
              : t('failed')
    );

  const ask = async () => {
    setBusy('ask');
    setError(null);
    const r = await apiPost<Proposal>(`${base}/suggest-store-categories`, {});
    setBusy(null);
    if (r.error || !r.data) return fail(r.error?.code);
    if (r.data.categories.length === 0) return setError(t('none'));
    setInfo({ unassigned: r.data.unassigned });
    setDrafts(r.data.categories.map((c, i) => ({ key: i, ...c, off: new Set<string>() })));
  };

  const apply = async () => {
    if (!drafts) return;
    const categories = drafts
      .filter(d => d.name.trim())
      .map(d => ({
        name: d.name.trim(),
        nameAr: d.nameAr.trim(),
        productIds: d.products.filter(p => !d.off.has(p.id)).map(p => p.id),
      }));
    if (categories.length === 0) return setDrafts(null);
    setBusy('apply');
    setError(null);
    const r = await apiPost(`${base}/apply-store-categories`, { categories });
    setBusy(null);
    if (r.error) return fail(r.error.code === 'INVALID_CATEGORIES' ? 'INVALID' : r.error.code);
    setDrafts(null);
    onCreated();
  };

  const patch = (key: number, fn: (d: Draft) => Draft) =>
    setDrafts(ds => ds && ds.map(d => (d.key === key ? fn(d) : d)));

  if (!drafts)
    return (
      <section
        className="mb-6 rounded-md border border-border bg-card p-4"
        data-testid="category-suggest"
      >
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <Button
          type="button"
          onClick={() => void ask()}
          disabled={busy !== null}
          data-testid="category-suggest-ask"
          variant="default"
          size="sm"
          className="mt-3 font-semibold"
        >
          {busy === 'ask' ? t('asking') : t('ask')}
        </Button>
      </section>
    );

  return (
    <section
      className="mb-6 rounded-md border border-border bg-card p-4"
      data-testid="category-suggest-review"
    >
      <h2 className="text-sm font-semibold">{t('reviewTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('reviewHint')}</p>
      <ul className="mt-3 space-y-3">
        {drafts.map(d => (
          <li key={d.key} className="rounded-lg border border-border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                {t('nameEn')}
                <input
                  dir="ltr"
                  maxLength={60}
                  value={d.name}
                  onChange={e => patch(d.key, x => ({ ...x, name: e.target.value }))}
                  className={`${FIELD_CLASSES} mt-1`}
                />
              </label>
              <label className="block text-sm font-medium">
                {t('nameAr')}
                <input
                  dir="rtl"
                  maxLength={60}
                  value={d.nameAr}
                  onChange={e => patch(d.key, x => ({ ...x, nameAr: e.target.value }))}
                  className={`${FIELD_CLASSES} mt-1`}
                />
              </label>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t('products', { count: d.products.length - d.off.size })}
              </summary>
              <ul className="mt-2 space-y-1">
                {d.products.map(p => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!d.off.has(p.id)}
                        onChange={e =>
                          patch(d.key, x => {
                            const off = new Set(x.off);
                            if (e.target.checked) off.delete(p.id);
                            else off.add(p.id);
                            return { ...x, off };
                          })
                        }
                      />
                      <bdi>{locale === 'ar' && p.nameAr ? p.nameAr : p.name}</bdi>
                    </label>
                  </li>
                ))}
              </ul>
            </details>
            <Button
              type="button"
              onClick={() => setDrafts(ds => (ds ? ds.filter(x => x.key !== d.key) : ds))}
              variant="link"
              size="sm"
              className="mt-2 text-destructive-ink"
            >
              {t('remove')}
            </Button>
          </li>
        ))}
      </ul>
      {info && info.unassigned > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('unassigned', { count: info.unassigned })}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          onClick={() => void apply()}
          disabled={busy !== null || drafts.every(d => !d.name.trim())}
          data-testid="category-suggest-apply"
          variant="default"
          size="sm"
          className="font-semibold"
        >
          {busy === 'apply' ? t('creating') : t('create')}
        </Button>
        <Button
          type="button"
          onClick={() => setDrafts(null)}
          disabled={busy !== null}
          variant="outline"
          size="sm"
        >
          {t('discard')}
        </Button>
      </div>
    </section>
  );
}
