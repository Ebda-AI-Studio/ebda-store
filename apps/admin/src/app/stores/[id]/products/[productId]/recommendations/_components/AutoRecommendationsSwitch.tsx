'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../../../lib/api';

/**
 * The store-wide switch for AUTOMATIC recommendations (bought-together + similar items).
 * `settings.autoRecommendationsEnabled`, absent = on; the merchant's own picks are never affected.
 */
export function AutoRecommendationsSwitch({ storeId }: { storeId: string }) {
  const t = useT('products.recommendations.auto');
  const { error: toastError } = useToast();
  const endpoint = `/api/v1/stores/${storeId}/recommendations/auto-setting`;
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!storeId) return;
    void apiGet<{ enabled: boolean }>(endpoint).then(({ data }) => {
      if (data) setEnabled(data.enabled);
    });
  }, [storeId, endpoint]);

  const toggle = async () => {
    if (enabled === null) return;
    const next = !enabled;
    const { error } = await apiPut<{ enabled: boolean }>(endpoint, { enabled: next });
    if (error) {
      toastError(t('saveFailed'), error.message);
      return;
    }
    setEnabled(next);
  };

  return (
    <div className="mb-6 flex items-start justify-between gap-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground" dir="auto">
          {t('title')}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
          {t('body')}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant={enabled ? 'default' : 'outline'}
        disabled={enabled === null}
        aria-pressed={enabled === true}
        onClick={() => void toggle()}
      >
        {enabled ? t('on') : t('off')}
      </Button>
    </div>
  );
}
