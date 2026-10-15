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
import { SEARCH_TERMS_MAX_LENGTH, analyzeSearchTerms } from '@ebda/shared';
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
  // Same shared cleaner the server runs, so the warning matches what will be saved.
  const { dropped, truncated } = analyzeSearchTerms(value);
  const atLimit = value.length >= SEARCH_TERMS_MAX_LENGTH;
  const nearLimit = !atLimit && value.length >= SEARCH_TERMS_MAX_LENGTH * 0.9;
  const status = atLimit ? t('searchTermsAtLimit') : nearLimit ? t('searchTermsNearLimit') : '';

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
        <p id={countId} dir="ltr" className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {String(value.length)} / {String(SEARCH_TERMS_MAX_LENGTH)}
        </p>
      </div>
      {/* Polite live region, always mounted so the change is announced: it only has
          text at 90% and at the limit. Visible text, so the state is not colour-only. */}
      <p
        aria-live="polite"
        className={`mt-1 text-xs ${atLimit ? 'font-medium text-destructive-ink' : 'text-muted-foreground'}`}
      >
        {status ? `\u26A0 ${status}` : ''}
      </p>
      {(dropped > 0 || truncated > 0) && (
        <p role="status" className="mt-1 text-xs font-medium text-destructive-ink">
          {dropped > 0 && (
            <span className="block">{t('searchTermsDropped', { count: String(dropped) })}</span>
          )}
          {truncated > 0 && (
            <span className="block">{t('searchTermsTruncated', { count: String(truncated) })}</span>
          )}
        </p>
      )}
    </div>
  );
}
