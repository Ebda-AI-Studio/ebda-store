'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';

/**
 * "Browser notifications for customers" switch. It used to sit in the branding theme tab, far from everything else
 * about notifications (UX:B-1); it still lives in `theme.storefrontWebPushEnabled`, so only that one key is sent.
 */
export function WebPushToggleCard({ storeId }: { storeId: string }) {
  const t = useT('notifications.webPush');
  const { success, error } = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<{ store?: { theme?: { storefrontWebPushEnabled?: boolean } } }>(
        `/api/v1/stores/${storeId}`
      );
      if (!cancelled) setEnabled(data?.store?.theme?.storefrontWebPushEnabled === true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  if (enabled === null) return null;

  async function onChange(next: boolean) {
    setBusy(true);
    const { error: err } = await apiPut(`/api/v1/stores/${storeId}/theme`, {
      storefrontWebPushEnabled: next,
    });
    setBusy(false);
    if (err) {
      error(t('failedTitle'), err.message || t('failedBody'));
      return;
    }
    setEnabled(next);
    success(next ? t('onToast') : t('offToast'), '');
  }

  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-md border border-border bg-card p-4">
      <span className="min-w-0 flex-1">
        <span
          data-setting-id="branding.web-push"
          className="block text-sm font-semibold text-foreground"
        >
          {t('title')}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{t('hint')}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        disabled={busy}
        onChange={e => void onChange(e.target.checked)}
        className="h-5 w-9 cursor-pointer accent-primary"
      />
    </label>
  );
}
