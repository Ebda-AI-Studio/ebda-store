'use client';

import { useState } from 'react';
import { apiPost } from '../../../../../../../lib/api';
import { useT } from '@/i18n/useT';

import { Button } from '@/components/ui/Button';
/**
 * AI-first autofill badge / hand-back control rendered beside each
 * AI-writable product field (nameAr, descriptionAr, metaTitle*, metaDescription*).
 *
 * - When the field is AI-owned (`aiFieldSources[field] === 'ai'`) it shows a
 *   passive "✨ AI" chip so the merchant knows the value came from the AI.
 * - When the field is HUMAN-owned (`=== 'human'`) it shows a "✨ Switch to AI"
 *   button. Clicking it clears the field + its provenance lock on the server
 *   and regenerates just that one field, then writes the new value back into
 *   the form via `onReset` so the input updates live and the chip flips to AI.
 *   A failed call surfaces a "⚠ Retry" state instead of silently no-op'ing.
 * - When the field has no provenance entry (empty / never AI-touched) it
 *   renders nothing.
 */
export function AiFieldBadge({
  field,
  sources,
  storeId,
  productId,
  onReset,
}: {
  field: string;
  sources?: Record<string, 'ai' | 'human'> | null;
  storeId?: string;
  productId?: string;
  onReset?: (field: string, value: string | null) => void;
}) {
  const t = useT('products.aiFieldBadge');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const owner = sources?.[field];

  if (owner === 'ai') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary-ink"
        title={t('aiGeneratedTitle')}
      >
        ✨ {t('aiLabel')}
      </span>
    );
  }

  if (owner === 'human' && storeId && productId) {
    return (
      <Button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          const { data, error } = await apiPost<{ field: string; value: string | null }>(
            `/api/v1/stores/${storeId}/ai/products/${productId}/ai/reset-field`,
            { field }
          );
          setBusy(false);
          if (error || !data) {
            setFailed(true); // surface the failure instead of silently no-op'ing
            return;
          }
          onReset?.(field, data.value);
        }}
        title={failed ? t('failedTitle') : t('handBackTitle')}
        variant="outline"
        size="sm"
        className={failed ? 'text-destructive-ink' : undefined}
      >
        {busy ? '…' : failed ? t('retryLabel') : t('switchToAiLabel')}
      </Button>
    );
  }

  return null;
}
