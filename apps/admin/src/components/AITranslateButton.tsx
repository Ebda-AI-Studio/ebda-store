'use client';

import { useState } from 'react';
import { apiPost } from '../lib/api';

/**
 * Inline AI translate button — sits next to a target field's label
 * and one-clicks an English↔Arabic translation in. Uses the source
 * field's current value, fills the target field through `onResult`.
 *
 * Disabled when the source is empty (nothing to translate). Shows a
 * spinner while the call is in flight, surfaces errors with a small
 * inline message, never blocks form submission.
 */

type Lang = 'en' | 'ar';
type TranslationKind =
  | 'product-name'
  | 'product-description'
  | 'category-name'
  | 'category-description'
  | 'meta-title'
  | 'meta-description'
  | 'store-name'
  | 'store-description'
  | 'free';

interface AITranslateButtonProps {
  storeId: string;
  source: string;
  from: Lang;
  to: Lang;
  kind: TranslationKind;
  onResult: (translation: string) => void;
  /** Optional shorter label override; defaults to "AI translate". */
  label?: string;
  size?: 'xs' | 'sm';
  className?: string;
}

export function AITranslateButton({
  storeId,
  source,
  from,
  to,
  kind,
  onResult,
  label,
  size = 'xs',
  className,
}: AITranslateButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !source.trim() || loading;

  async function handleClick() {
    if (disabled) return;
    setError(null);
    setLoading(true);
    try {
      const { data, error: apiError } = await apiPost<{ translation: string; cached: boolean }>(
        `/api/v1/stores/${storeId}/ai/translate`,
        { text: source.trim(), from, to, kind }
      );
      if (apiError || !data) {
        setError(apiError?.message || 'Translation failed');
        return;
      }
      onResult(data.translation);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  const sizeClass = size === 'xs' ? 'text-[11px] px-2 py-1' : 'text-xs px-3 py-1.5';
  const arrow = from === 'en' ? '→ ع' : '→ EN';

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 rounded-md border border-[#fc6b02]/30 bg-[#fc6b02]/5 font-medium text-[#fc6b02] transition-colors hover:bg-[#fc6b02]/10 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClass}`}
        title={
          disabled && !loading
            ? `Fill the ${from === 'en' ? 'English' : 'Arabic'} version first`
            : undefined
        }
      >
        {loading ? (
          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <span aria-hidden>✨</span>
        )}
        <span>{label ?? `AI ${arrow}`}</span>
      </button>
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </span>
  );
}
