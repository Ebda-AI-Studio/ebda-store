'use client';

import { Button } from '@/components/ui/Button';
import { SparkleIcon } from './SparkleIcon';
import { useState } from 'react';
import { apiPost } from '../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Page-level "Translate missing Arabic / English" button.
 *
 * Walks a set of EN/AR field pairs and only translates the side that's
 * empty. If both sides are filled or both empty, the pair is skipped —
 * we never overwrite content the user already has, and we never
 * "translate" a blank string into an Arabic blank.
 *
 * The smart-skip rule is the whole point: a merchant on a 200-product
 * catalogue clicks once, and only the genuinely missing fields get
 * filled in. Cached identical strings cost nothing on the AI side
 * (the service has a 7-day Redis cache).
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

export interface TranslatePair {
  /** Stable key for status reporting (e.g. "name", "description"). */
  key: string;
  /** Current English value (may be empty). */
  en: string;
  /** Current Arabic value (may be empty). */
  ar: string;
  /** AI service kind hint — controls tone + length limit. */
  kind: TranslationKind;
  /** Called when EN is missing and AR was translated to fill EN. */
  onEnFilled: (value: string) => void;
  /** Called when AR is missing and EN was translated to fill AR. */
  onArFilled: (value: string) => void;
}

interface AITranslateMissingButtonProps {
  storeId: string;
  pairs: TranslatePair[];
  /** Optional override for the button label. */
  label?: string;
  className?: string;
}

interface RunSummary {
  filled: number;
  skipped: number;
  failed: number;
  skippedReasons: { both: number; empty: number };
}

export function AITranslateMissingButton({
  storeId,
  pairs,
  label,
  className,
}: AITranslateMissingButtonProps) {
  const t = useT('components.aiTranslateButton');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const candidatePairs = pairs.filter(p => {
    const enFilled = p.en.trim().length > 0;
    const arFilled = p.ar.trim().length > 0;
    // We translate only when EXACTLY one side is filled.
    return enFilled !== arFilled;
  });

  const disabled = running || candidatePairs.length === 0;

  async function handleClick() {
    if (disabled) return;
    setSummary(null);

    const summary: RunSummary = {
      filled: 0,
      skipped: 0,
      failed: 0,
      skippedReasons: { both: 0, empty: 0 },
    };

    for (const p of pairs) {
      const enFilled = p.en.trim().length > 0;
      const arFilled = p.ar.trim().length > 0;
      if (enFilled && arFilled) {
        summary.skipped++;
        summary.skippedReasons.both++;
      } else if (!enFilled && !arFilled) {
        summary.skipped++;
        summary.skippedReasons.empty++;
      }
    }

    setRunning(true);
    setProgress({ done: 0, total: candidatePairs.length });

    let done = 0;
    for (const p of candidatePairs) {
      const enFilled = p.en.trim().length > 0;
      const sourceText = enFilled ? p.en : p.ar;
      const from: Lang = enFilled ? 'en' : 'ar';
      const to: Lang = enFilled ? 'ar' : 'en';

      try {
        const { data, error } = await apiPost<{ translation: string; cached: boolean }>(
          `/api/v1/stores/${storeId}/ai/translate`,
          { text: sourceText, from, to, kind: p.kind }
        );
        if (error || !data || !data.translation) {
          summary.failed++;
        } else if (to === 'ar') {
          p.onArFilled(data.translation);
          summary.filled++;
        } else {
          p.onEnFilled(data.translation);
          summary.filled++;
        }
      } catch {
        summary.failed++;
      }

      done++;
      setProgress({ done, total: candidatePairs.length });
    }

    setRunning(false);
    setProgress(null);
    setSummary(summary);
  }

  const buttonLabel =
    label ??
    (running && progress
      ? t('translating', { done: progress.done, total: progress.total })
      : candidatePairs.length === 0
        ? t('nothing')
        : t('translate', { count: candidatePairs.length }));

  return (
    <div className={className}>
      <Button
        variant="outline"
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="gap-2 font-semibold"
      >
        {running ? (
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
          <SparkleIcon />
        )}
        <span>{buttonLabel}</span>
      </Button>
      {summary && (
        <p className="mt-2 text-xs text-muted-foreground">
          {summary.filled > 0 && <span>{t('summaryFilled', { count: summary.filled })}</span>}
          {summary.skippedReasons.both > 0 && (
            <span>{t('summarySkippedBoth', { count: summary.skippedReasons.both })}</span>
          )}
          {summary.skippedReasons.empty > 0 && (
            <span>{t('summarySkippedEmpty', { count: summary.skippedReasons.empty })}</span>
          )}
          {summary.failed > 0 && (
            <span className="text-destructive-ink">
              {t('summaryFailed', { count: summary.failed })}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
