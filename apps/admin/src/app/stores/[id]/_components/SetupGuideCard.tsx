'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import {
  SETUP_GUIDE_ITEMS,
  buildStoreShareMessage,
  resolveDefaultLanguage,
  waMeShareLink,
  type WaMeLocale,
  type SetupGuideKey,
  type SetupGuideState,
} from '@ebda/shared';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Setup-guide checklist on the store dashboard. Every row's `done` comes from
 * the API, which derives it from real store data (products, logo/colour,
 * shipping zones, ...); only `payment`, `domain` and `share` can be ticked by
 * hand. Hiding the guide persists on the store, not in the browser.
 */
export function SetupGuideCard({
  storeId,
  storeUrl,
  storeName = '',
  locale = resolveDefaultLanguage(undefined),
}: {
  storeId: string;
  storeUrl: string;
  storeName?: string;
  /** Language of the share text — the store's default language (customers read it). */
  locale?: WaMeLocale;
}) {
  const t = useT('onboarding.setupGuide');
  const [guide, setGuide] = useState<SetupGuideState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const base = `/api/v1/stores/${storeId}/setup-guide`;

  const load = useCallback(async () => {
    const { data, error } = await apiGet<SetupGuideState>(base);
    if (error || !data) setFailed(true);
    else setGuide(data);
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  async function setManual(key: SetupGuideKey, done: boolean) {
    setBusy(key);
    const { data } = await apiPut<SetupGuideState>(`${base}/items/${key}`, { done });
    if (data) setGuide(data);
    setBusy(null);
  }

  async function setDismissed(dismissed: boolean) {
    setBusy('dismissed');
    const { data } = await apiPut<SetupGuideState>(`${base}/dismissed`, { dismissed });
    if (data) setGuide(data);
    setBusy(null);
  }

  if (failed) {
    return (
      <p role="alert" className="mb-6 text-sm text-muted-foreground">
        {t('loadFailed')}
      </p>
    );
  }
  if (!guide) return null;

  const allRequiredDone = guide.requiredDone === guide.requiredTotal;
  // C3: with no delivery rates the storefront cannot charge for delivery. This warning stays
  // visible even when the guide is hidden or otherwise finished, until a rate exists.
  const shippingMissing = guide.items.some(i => i.key === 'shipping' && !i.done);
  const shippingWarning = shippingMissing ? (
    <div
      role="alert"
      data-testid="shipping-missing-warning"
      className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-foreground"
    >
      <p className="font-medium">{t('shippingWarning.title')}</p>
      <p className="mt-1 text-muted-foreground">{t('shippingWarning.body')}</p>
      <Link
        href={`/stores/${storeId}/shipping`}
        className="mt-2 inline-flex min-h-11 items-center font-medium text-primary underline"
      >
        {t('shippingWarning.cta')}
      </Link>
    </div>
  ) : null;
  if (guide.dismissed || allRequiredDone) {
    // Finished or hidden: one quiet line, never a wall of chrome.
    return guide.dismissed ? (
      <>
        {shippingWarning}
        <div className="mb-6">
          <Button
            variant="link"
            size="sm"
            type="button"
            onClick={() => setDismissed(false)}
            disabled={busy === 'dismissed'}
          >
            {t('show')}
          </Button>
        </div>
      </>
    ) : (
      shippingWarning
    );
  }

  const percent = Math.round((guide.doneCount / guide.totalCount) * 100);

  return (
    <>
      {shippingWarning}
      <section
        aria-labelledby="setup-guide-title"
        className="mb-6 rounded-xl border border-border bg-card p-4 md:p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="setup-guide-title" className="text-base font-semibold text-foreground">
              {t('title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-muted-foreground"
            type="button"
            onClick={() => setDismissed(true)}
            disabled={busy === 'dismissed'}
          >
            {t('dismiss')}
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={guide.totalCount}
            aria-valuenow={guide.doneCount}
            aria-label={t('progress', { done: guide.doneCount, total: guide.totalCount })}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">
            {t('progress', { done: guide.doneCount, total: guide.totalCount })}
          </span>
        </div>

        <ul className="mt-3 divide-y divide-border">
          {guide.items.map(item => {
            const def = SETUP_GUIDE_ITEMS.find(d => d.key === item.key)!;
            const title = t(`items.${item.key}.title` as Parameters<typeof t>[0]);
            const desc = t(`items.${item.key}.desc` as Parameters<typeof t>[0]);
            return (
              <li
                key={item.key}
                data-key={item.key}
                data-done={item.done}
                className="flex flex-wrap items-start gap-3 py-3 sm:flex-nowrap sm:items-center"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                    item.done
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-transparent'
                  }`}
                >
                  ✓
                </span>
                <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
                  <p
                    className={`text-sm font-medium ${
                      item.done ? 'text-muted-foreground line-through' : 'text-foreground'
                    }`}
                  >
                    {title}
                    {item.optional && (
                      <span className="ms-2 inline-block whitespace-nowrap rounded-full bg-muted px-2 py-0.5 align-middle text-xs font-normal text-muted-foreground">
                        {t('optional')}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                </div>
                <div className="ms-8 flex flex-wrap items-center gap-2 sm:ms-0 sm:shrink-0">
                  {item.key === 'share' ? (
                    <a
                      href={waMeShareLink(
                        buildStoreShareMessage({ locale, storeName, url: storeUrl })
                      )}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => {
                        if (!item.done) void setManual('share', true);
                      }}
                    >
                      <Button type="button" size="sm" variant="outline">
                        {t('open')}
                      </Button>
                    </a>
                  ) : item.key === 'test_order' ? (
                    <a href={storeUrl} target="_blank" rel="noreferrer">
                      <Button type="button" size="sm" variant="outline">
                        {t('open')}
                      </Button>
                    </a>
                  ) : (
                    !item.done && (
                      <Link href={`/stores/${storeId}/${def.href}`}>
                        <Button type="button" size="sm" variant="outline">
                          {t('open')}
                        </Button>
                      </Link>
                    )
                  )}
                  {item.manual && item.key !== 'share' && !item.fromData && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy === item.key}
                      onClick={() => setManual(item.key, !item.done)}
                    >
                      {item.done ? t('markUndone') : t('markDone')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
