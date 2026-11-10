'use client';

/**
 * "Generate with AI" for a section's kicker and subtitle (bilingual). Calls /ai/section-content;
 * the caller decides what to keep (the page builder and the editor only fill EMPTY fields).
 */
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiPost } from '../../lib/api';

/**
 * "Generate with AI" button used next to section content fields
 * (kicker + subtitle). Calls /ai/section-content + only fills empty
 * fields so a merchant's existing values aren't overwritten. Loading
 * state + success/error toast included.
 */
export function AiSectionFillButton({
  storeId,
  section,
  existingTitle,
  existingTitleAr,
  onFilled,
}: {
  storeId: string;
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  existingTitle?: string;
  existingTitleAr?: string;
  onFilled: (r: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string }) => void;
}) {
  const t = useT('orders.layout');
  const [busy, setBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();
  const generate = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        suggestion: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string };
      }>(`/api/v1/stores/${storeId}/ai/section-content`, {
        section,
        existingTitle: existingTitle || undefined,
        existingTitleAr: existingTitleAr || undefined,
      });
      if (error || !data) {
        toastError(t('aiSectionFill.failedTitle'), error?.message ?? '');
        return;
      }
      onFilled(data.suggestion);
      toastSuccess(t('aiSectionFill.successTitle'));
    } catch (e) {
      toastError(t('aiSectionFill.failedTitle'), e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={generate}
      disabled={busy}
      className="gap-1.5"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
      {busy ? t('aiSectionFill.generating') : t('aiSectionFill.generateWithAi')}
    </Button>
  );
}
