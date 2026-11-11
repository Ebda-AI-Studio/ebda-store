'use client';

/**
 * FactsCard: repeatable "product details" row editor (fabric, care, karat...).
 *
 * Controlled and presentational: it only edits the page's form state. The
 * edit page owns the single PUT (one writer), so there is no save button here.
 * Storefront shows these as a table under the buy box, up to 2 as card chips.
 */

import { useRef, useState } from 'react';
import { Input } from '@ebda/ui';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { PRODUCT_FACTS_MAX, PRODUCT_FACTS_ON_CARD_MAX, type ProductFact } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiPost } from '@/lib/api';

const PRESETS: Array<{ key: string; keyAr: string }> = [
  { key: 'Fabric', keyAr: 'الخامة' },
  { key: 'Care', keyAr: 'العناية' },
  { key: 'Model wears', keyAr: 'المقاس على الموديل' },
  { key: 'Origin', keyAr: 'المنشأ' },
  { key: 'Karat', keyAr: 'العيار' },
  { key: 'Ingredients', keyAr: 'المكونات' },
];

type Field = 'key' | 'keyAr' | 'value' | 'valueAr';

interface Props {
  storeId: string;
  facts: ProductFact[];
  onChange: (next: ProductFact[]) => void;
}

export function FactsCard({ storeId, facts, onChange }: Props) {
  const t = useT('products.edit.facts');
  const locale = useLocale();
  const [busy, setBusy] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ index: number; message: string } | null>(null);

  // Latest facts, so an async translate patches current state, not the render it started in.
  const factsRef = useRef(facts);
  factsRef.current = facts;

  const onCardCount = facts.filter(f => f.onCard).length;
  const patch = (i: number, p: Partial<ProductFact>) =>
    onChange(facts.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= facts.length) return;
    const next = [...facts];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = (preset?: { key: string; keyAr: string }) =>
    onChange([
      ...facts,
      { key: preset?.key ?? '', keyAr: preset?.keyAr ?? '', value: '', valueAr: '', onCard: false },
    ]);

  // Fill each EMPTY side of a row from the filled one (never overwrites text).
  async function translateRow(i: number) {
    const row = facts[i];
    const pairs: Array<[Field, Field]> = [
      ['key', 'keyAr'],
      ['value', 'valueAr'],
    ];
    setBusy(i);
    setRowError(null);
    const next: Partial<ProductFact> = {};
    for (const [en, ar] of pairs) {
      const hasEn = row[en].trim().length > 0;
      const hasAr = row[ar].trim().length > 0;
      if (hasEn === hasAr) continue;
      const { data, error } = await apiPost<{ translation: string }>(
        `/api/v1/stores/${storeId}/ai/translate`,
        {
          text: hasEn ? row[en] : row[ar],
          from: hasEn ? 'en' : 'ar',
          to: hasEn ? 'ar' : 'en',
          kind: 'free',
        }
      );
      if (error || !data?.translation) {
        setRowError({ index: i, message: error?.message || t('translateFailed') });
        break;
      }
      next[hasEn ? ar : en] = data.translation;
    }
    setBusy(null);
    // Patch against the LATEST facts; only fill sides still empty (never overwrite edits).
    const latest = factsRef.current;
    const cur = latest[i];
    if (!cur) return;
    const fill: Partial<ProductFact> = {};
    for (const [k, v] of Object.entries(next) as Array<[Field, string]>) {
      if (!cur[k].trim()) fill[k] = v;
    }
    if (Object.keys(fill).length)
      onChange(latest.map((f, idx) => (idx === i ? { ...f, ...fill } : f)));
  }

  const canTranslate = (f: ProductFact) =>
    f.key.trim().length > 0 !== f.keyAr.trim().length > 0 ||
    f.value.trim().length > 0 !== f.valueAr.trim().length > 0;

  const iconBtn = buttonVariants({ variant: 'outline', size: 'icon-sm' });
  const cell = 'h-9 sm:h-9 text-sm';

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>

      {facts.length < PRODUCT_FACTS_MAX && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('presets')}>
          {PRESETS.map(p => (
            <Button key={p.key} type="button" onClick={() => add(p)} variant="outline" size="sm">
              + {locale === 'ar' ? p.keyAr : p.key}
            </Button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {facts.map((f, i) => (
          <div key={i} className="rounded-lg border border-border p-3" data-testid="fact-row">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label={t('keyEn')}
                placeholder={t('keyEn')}
                value={f.key}
                maxLength={40}
                onChange={e => patch(i, { key: e.target.value })}
                className={cell}
              />
              <Input
                aria-label={t('keyAr')}
                placeholder={t('keyAr')}
                value={f.keyAr}
                maxLength={40}
                lang="ar"
                dir="rtl"
                onChange={e => patch(i, { keyAr: e.target.value })}
                className={cell}
              />
              <Input
                aria-label={t('valueEn')}
                placeholder={t('valueEn')}
                value={f.value}
                maxLength={120}
                onChange={e => patch(i, { value: e.target.value })}
                className={cell}
              />
              <Input
                aria-label={t('valueAr')}
                placeholder={t('valueAr')}
                value={f.valueAr}
                maxLength={120}
                lang="ar"
                dir="rtl"
                onChange={e => patch(i, { valueAr: e.target.value })}
                className={cell}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={f.onCard}
                  disabled={!f.onCard && onCardCount >= PRODUCT_FACTS_ON_CARD_MAX}
                  onChange={e => patch(i, { onCard: e.target.checked })}
                />
                {t('onCard')}
              </label>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  onClick={() => translateRow(i)}
                  disabled={busy !== null || !canTranslate(f)}
                  variant="outline"
                  size="sm"
                >
                  {busy === i ? t('translating') : t('translate')}
                </Button>
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => move(i, -1)}
                  // A translation in flight writes back BY INDEX: reordering or removing a
                  // row meanwhile would land it on the wrong fact.
                  disabled={busy !== null || i === 0}
                  aria-label={t('moveUp')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => move(i, 1)}
                  disabled={busy !== null || i === facts.length - 1}
                  aria-label={t('moveDown')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={iconBtn}
                  onClick={() => onChange(facts.filter((_, idx) => idx !== i))}
                  disabled={busy !== null}
                  aria-label={t('remove')}
                >
                  ×
                </button>
              </div>
            </div>
            {rowError?.index === i && (
              <p role="alert" className="mt-2 text-xs text-destructive-ink">
                {rowError.message}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => add()}
          disabled={facts.length >= PRODUCT_FACTS_MAX}
        >
          {t('add')}
        </Button>
        {onCardCount >= PRODUCT_FACTS_ON_CARD_MAX && (
          <p className="text-xs text-muted-foreground">{t('cardFull')}</p>
        )}
      </div>
    </div>
  );
}
