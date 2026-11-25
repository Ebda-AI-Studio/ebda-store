'use client';

/**
 * The merchant's master AI switch (`stores.ai_features_enabled`, default on). Off = no AI call for this store from
 * any entry point (translate, SEO, sweeps, the autopilot, campaign drafts, review replies, the page editor).
 * Lives on the AI usage page (anchored `ai.switch` there) and the AI tools page. The API refuses the other AI routes while it is off, but never
 * these two settings routes, so the merchant can always turn it back on.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '@/i18n/useT';

export function AiSwitchCard({
  storeId,
  onChange,
}: {
  storeId: string;
  /** Reports the switch state so a page can disable its AI buttons while it is off. */
  onChange?: (enabled: boolean) => void;
}) {
  const t = useT('aiSwitch');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [quota, setQuota] = useState<{ used: number; cap: number; remaining: number } | null>(null);
  const tAddons = useT('addons');
  const base = `/api/v1/stores/${storeId}/ai/settings`;

  const load = useCallback(async () => {
    const r = await apiGet<{ enabled: boolean }>(base);
    if (r.error || !r.data) return setFailed(true);
    setFailed(false);
    setEnabled(r.data.enabled);
    onChange?.(r.data.enabled);
  }, [base, onChange]);
  useEffect(() => {
    void load();
    // Today's allowance (base + paid packs) from the billing add-ons read; a miss just hides the line.
    void apiGet<{ ai: { used: number; cap: number; remaining: number } }>(
      `/api/v1/stores/${storeId}/billing/addons`
    ).then(r => setQuota(r.data?.ai ?? null));
  }, [load, storeId]);

  const flip = async () => {
    if (enabled === null || busy) return;
    setBusy(true);
    setFailed(false);
    const r = await apiPut<{ enabled: boolean }>(base, { enabled: !enabled });
    setBusy(false);
    if (r.error || !r.data) return setFailed(true);
    setEnabled(r.data.enabled);
    onChange?.(r.data.enabled);
  };

  return (
    <section className="rounded-md border border-border bg-card p-4" data-testid="ai-switch-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="ai-switch-title" className="text-sm font-semibold">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {enabled === false ? t('offHint') : t('onHint')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled === true}
          aria-labelledby="ai-switch-title"
          disabled={enabled === null || busy}
          onClick={() => void flip()}
          data-testid="ai-switch"
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 max-sm:before:absolute max-sm:before:-inset-y-2.5 max-sm:before:inset-x-0 max-sm:before:content-[''] ${enabled ? 'bg-primary' : 'bg-muted'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'}`}
          />
        </button>
      </div>
      {quota && (
        <p className="mt-3 text-sm" data-testid="ai-quota">
          {tAddons('aiToday', quota)}{' '}
          <Link
            href={`/stores/${storeId}/billing/addons#ai`}
            className="font-medium text-primary underline"
          >
            {t('quotaLink')}
          </Link>
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-destructive-ink">
          {t('failed')}
        </p>
      )}
    </section>
  );
}
