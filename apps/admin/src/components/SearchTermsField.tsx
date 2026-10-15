'use client';

/**
 * Merchant-editable "search words" (products.search_terms), shared by the product
 * edit and new pages. Extra words shoppers type for this product (dialect, Franco
 * like "3abaya", English). Indexed for search, never displayed in the storefront.
 * The server re-cleans and caps at SEARCH_TERMS_MAX_LENGTH, so the counter is
 * guidance only. Counter digits are Latin on purpose (NUMERALS-1): String(), never
 * toLocaleString, so they never turn Arabic-Indic.
 */

import { useId } from 'react';
import { Textarea } from '@ebda/ui';
import { SEARCH_TERMS_MAX_LENGTH } from '@ebda/shared';
import { useT } from '@/i18n/useT';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** i18n namespace holding searchTerms* keys ('products.edit.fields' | 'products.new.fields'). */
  namespace: 'products.edit.fields' | 'products.new.fields';
}

export function SearchTermsField({ value, onChange, namespace }: Props) {
  const t = useT(namespace);
  const id = useId();
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const nearLimit = value.length >= SEARCH_TERMS_MAX_LENGTH * 0.9;

  return (
    <div>
      <Textarea
        id={id}
        label={t('searchTerms')}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('searchTermsPlaceholder')}
        rows={2}
        maxLength={SEARCH_TERMS_MAX_LENGTH}
        dir="auto"
        aria-describedby={`${hintId} ${countId}`}
      />
      <div className="mt-1 flex items-start justify-between gap-3">
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('searchTermsHint')}
        </p>
        <p
          id={countId}
          dir="ltr"
          className={`shrink-0 text-xs tabular-nums ${nearLimit ? 'text-destructive-ink' : 'text-muted-foreground'}`}
        >
          {String(value.length)} / {String(SEARCH_TERMS_MAX_LENGTH)}
        </p>
      </div>
    </div>
  );
}
