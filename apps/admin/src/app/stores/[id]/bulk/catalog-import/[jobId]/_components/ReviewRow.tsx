'use client';

import { useState } from 'react';
import { Input, Label } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import {
  BLOCKING_FLAGS,
  confidenceBand,
  egpToMinor,
  minorToEgp,
  type ReviewItem,
} from '../../_lib/api';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface Props {
  item: ReviewItem;
  categories: Array<{ id: string; name: string; nameAr: string | null }>;
  /** Persist a patch; resolves to an error code or null. */
  onPatch: (id: string, body: object) => Promise<string | null>;
  onOpenSource: (fileId: string) => void;
  locked: boolean;
}

const BAND_STYLE = {
  high: 'bg-success/10 text-success-ink',
  medium: 'bg-warning/10 text-warning-ink',
  low: 'bg-destructive/10 text-destructive-ink',
} as const;

/** One extracted product: every field editable in place, saved on blur, accept / reject at the end. */
export function ReviewRow({ item, categories, onPatch, onOpenSource, locked }: Props) {
  const t = useT('bulk.catalogImport.review');
  const [err, setErr] = useState<string | null>(null);
  const [price, setPrice] = useState(minorToEgp(item.priceMinor));
  const band = confidenceBand(item.confidence);
  const blocking = item.flags.filter(
    f => (BLOCKING_FLAGS as readonly string[]).includes(f) && !item.acknowledged.includes(f)
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const canAccept = blocking.every(f => checked.has(f));
  const disabled = locked || item.status === 'created';

  async function save(body: object) {
    setErr(null);
    const code = await onPatch(item.id, body);
    if (code) setErr(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.GENERIC'));
  }

  const field = (
    key: 'name' | 'nameAr' | 'sku' | 'description' | 'descriptionAr',
    label: string,
    dir?: 'rtl' | 'ltr'
  ) => (
    <div>
      <Label htmlFor={`${item.id}-${key}`}>{label}</Label>
      <Input
        id={`${item.id}-${key}`}
        dir={dir}
        defaultValue={item[key] ?? ''}
        disabled={disabled}
        maxLength={key.startsWith('description') ? 2000 : 300}
        onBlur={e => {
          const v = e.target.value.trim();
          if (v !== (item[key] ?? '')) void save({ [key]: v === '' ? null : v });
        }}
        className="mt-1"
      />
    </div>
  );

  return (
    <li className="rounded-md border bg-card p-4" data-testid="review-row">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${BAND_STYLE[band]}`}
          aria-label={t('confidenceAria', { level: t(`band.${band}`) })}
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            {band === 'high' ? (
              <path d="M4.5 8.6 2.4 6.5l-.9.9 3 3 6-6-.9-.9z" />
            ) : band === 'medium' ? (
              <rect x="2" y="5.3" width="8" height="1.4" rx=".7" />
            ) : (
              <path d="M6 1 .8 10.5h10.4L6 1zm-.6 3.6h1.2v3H5.4v-3zm0 3.9h1.2v1.2H5.4V8.5z" />
            )}
          </svg>
          {t(`band.${band}`)}
        </span>
        {item.flags.map(f => (
          <span key={f} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t.has(`flags.${f}`) ? t(`flags.${f}`) : f}
          </span>
        ))}
        <Button
          variant="link"
          size="sm"
          className="ms-auto"
          type="button"
          onClick={() => onOpenSource(item.fileId)}
        >
          {t('openSource')}
        </Button>
      </div>

      {item.sourceText && (
        <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" dir="auto">
          <span className="font-medium">{t('printedAs')}</span> {item.sourceText}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {field('nameAr', t('nameAr'), 'rtl')}
        {field('name', t('nameEn'), 'ltr')}
        <div>
          <Label htmlFor={`${item.id}-price`}>{t('price')}</Label>
          <Input
            id={`${item.id}-price`}
            inputMode="decimal"
            dir="ltr"
            value={price}
            disabled={disabled}
            onChange={e => setPrice(e.target.value)}
            onBlur={() => {
              const m = egpToMinor(price);
              if (m === undefined) return setErr(t('errors.BAD_PRICE'));
              if (m !== item.priceMinor) void save({ priceMinor: m });
            }}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={`${item.id}-cat`}>{t('category')}</Label>
          <select
            id={`${item.id}-cat`}
            value={item.categoryId ?? ''}
            disabled={disabled}
            onChange={e => void save({ categoryId: e.target.value || null })}
            className={`${FIELD_CLASSES} mt-1`}
          >
            <option value="">{item.categoryName ? t('noCategoryYet') : t('noCategory')}</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>
                {c.nameAr ?? c.name}
              </option>
            ))}
          </select>
          {!item.categoryId && item.categoryName && (
            <label className="mt-2 flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={item.acknowledged.includes('create_category')}
                disabled={disabled}
                onChange={e => void save({ createCategory: e.target.checked })}
              />
              {t('createCategory', { name: item.categoryName })}
            </label>
          )}
        </div>
      </div>

      {item.variants.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-foreground">
            {t('variants', { count: item.variants.length })}
          </p>
          <ul className="mt-1 grid gap-1 sm:grid-cols-2">
            {item.variants.map((v, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span dir="auto">{Object.values(v.options).join(' / ') || '-'}</span>
                <Input
                  aria-label={t('variantPrice', { name: Object.values(v.options).join(' / ') })}
                  inputMode="decimal"
                  dir="ltr"
                  className="h-8 w-24"
                  defaultValue={minorToEgp(v.priceMinor)}
                  disabled={disabled}
                  onBlur={e => {
                    const m = egpToMinor(e.target.value);
                    if (m === undefined || m === v.priceMinor) return;
                    const next = item.variants.map((x, j) =>
                      j === i ? { ...x, priceMinor: m } : x
                    );
                    void save({ variants: next });
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3">
        <summary className="min-h-11 cursor-pointer text-xs font-medium text-muted-foreground sm:min-h-0">
          {t('moreDetails')}
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {field('sku', t('sku'), 'ltr')}
          <div>
            <Label htmlFor={`${item.id}-tags`}>{t('tags')}</Label>
            <Input
              id={`${item.id}-tags`}
              defaultValue={item.tags.join('، ')}
              disabled={disabled}
              onBlur={e => {
                const tags = e.target.value
                  .split(/[,،]/)
                  .map(s => s.trim())
                  .filter(Boolean);
                if (tags.join('|') !== item.tags.join('|')) void save({ tags });
              }}
              className="mt-1"
            />
          </div>

          {field('descriptionAr', t('descriptionAr'), 'rtl')}
          {field('description', t('descriptionEn'), 'ltr')}
        </div>
      </details>

      {blocking.length > 0 && item.status !== 'accepted' && (
        <div className="mt-3 space-y-1" role="group" aria-label={t('checkTitle')}>
          {blocking.map(f => (
            <label key={f} className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={checked.has(f)}
                onChange={e => {
                  const next = new Set(checked);
                  if (e.target.checked) next.add(f);
                  else next.delete(f);
                  setChecked(next);
                }}
              />
              {t(`check.${f}`)}
            </label>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {item.status === 'created' ? (
          <span className="text-xs font-medium text-success-ink">{t('draftCreated')}</span>
        ) : (
          <>
            <Button
              size="sm"
              variant={item.status === 'accepted' ? 'secondary' : 'default'}
              disabled={disabled || (item.status !== 'accepted' && !canAccept)}
              onClick={() =>
                void save(
                  item.status === 'accepted'
                    ? { status: 'pending' }
                    : { status: 'accepted', acknowledge: [...checked] }
                )
              }
            >
              {item.status === 'accepted' ? t('undo') : t('accept')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || item.status === 'rejected'}
              onClick={() => void save({ status: 'rejected' })}
            >
              {t('reject')}
            </Button>
          </>
        )}
        {item.status === 'failed' && item.createErrorCode && (
          <span role="alert" className="text-xs text-destructive-ink">
            {t.has(`errors.${item.createErrorCode}`)
              ? t(`errors.${item.createErrorCode}`)
              : t('errors.GENERIC')}
          </span>
        )}
        {err && (
          <span role="alert" className="text-xs text-destructive-ink">
            {err}
          </span>
        )}
      </div>
    </li>
  );
}
