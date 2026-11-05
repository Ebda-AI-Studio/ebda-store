'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../../lib/api';
import type { QrKind } from '@ebda/shared/qr';
import { Segmented } from './Segmented';
import type { QrTarget } from '../_hooks/useQr';

type Option = { id: string; name: string; nameAr?: string | null; slug: string };

type Props = {
  storeId: string;
  target: QrTarget;
  onChange: (t: QrTarget) => void;
  hasWhatsapp: boolean;
  link: string | null;
};

export function TargetPicker({ storeId, target, onChange, hasWhatsapp, link }: Props) {
  const t = useT('qr.target');
  const locale = useLocale();
  const nameOf = (o: Option) => (locale === 'ar' && o.nameAr ? o.nameAr : o.name);
  const [categories, setCategories] = useState<Option[]>([]);
  const [results, setResults] = useState<Option[]>([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (target.kind !== 'category' || categories.length) return;
    apiGet<{ categories: Option[] }>(`/api/v1/stores/${storeId}/categories`).then(({ data }) =>
      setCategories((data?.categories ?? []).filter(c => c.slug))
    );
  }, [target.kind, categories.length, storeId]);

  useEffect(() => {
    if (target.kind !== 'product') return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearched(false);
      return;
    }
    const timer = setTimeout(async () => {
      const { data } = await apiGet<{ products: Option[] }>(
        `/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=8`
      );
      setResults((data?.products ?? []).filter(p => p.slug));
      setSearched(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [target.kind, query, storeId]);

  const kinds: Array<{ value: QrKind; label: string }> = [
    { value: 'store', label: t('store') },
    { value: 'product', label: t('product') },
    { value: 'category', label: t('category') },
    { value: 'whatsapp', label: t('whatsapp') },
  ];

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
      <Segmented
        label={t('title')}
        value={target.kind}
        options={kinds}
        onChange={kind => {
          setQuery('');
          onChange({ kind });
        }}
      />

      {target.kind === 'product' && (
        <div className="space-y-2">
          <label htmlFor="qr-product-search" className="block text-sm text-muted-foreground">
            {t('productSearch')}
          </label>
          {target.slug ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="truncate font-medium text-foreground">{target.label}</span>
              <button
                type="button"
                className="shrink-0 text-primary-ink underline underline-offset-2"
                onClick={() => onChange({ kind: 'product' })}
              >
                {t('productPlaceholder')}
              </button>
            </div>
          ) : (
            <>
              <input
                id="qr-product-search"
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('productPlaceholder')}
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary/40"
              />
              {results.length > 0 && (
                <ul className="max-h-56 overflow-auto rounded-lg border border-border divide-y divide-border">
                  {results.map(p => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                        onClick={() =>
                          onChange({ kind: 'product', slug: p.slug, label: nameOf(p) })
                        }
                      >
                        {nameOf(p)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searched && results.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('noResults')}</p>
              )}
            </>
          )}
        </div>
      )}

      {target.kind === 'category' && (
        <select
          aria-label={t('category')}
          value={target.slug ?? ''}
          onChange={e => {
            const c = categories.find(x => x.slug === e.target.value);
            onChange(
              c ? { kind: 'category', slug: c.slug, label: nameOf(c) } : { kind: 'category' }
            );
          }}
          className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary/40"
        >
          <option value="">{t('categoryPlaceholder')}</option>
          {categories.map(c => (
            <option key={c.id} value={c.slug}>
              {nameOf(c)}
            </option>
          ))}
        </select>
      )}

      {target.kind === 'whatsapp' && !hasWhatsapp && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t('noWhatsapp')}
        </p>
      )}

      <div className="text-xs text-muted-foreground">
        <span>{t('linkLabel')}: </span>
        <bdi dir="ltr" className="break-all font-mono text-foreground">
          {link ?? t('pickFirst')}
        </bdi>
      </div>
    </div>
  );
}
