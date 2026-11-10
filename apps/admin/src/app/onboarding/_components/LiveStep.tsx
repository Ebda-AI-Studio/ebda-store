'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@ebda/ui';
import {
  buildStoreShareMessage,
  getLook,
  TEMPLATE_FAMILIES,
  resolveDefaultLanguage,
  waMeShareLink,
} from '@ebda/shared';
import { apiPost } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import type { OnboardingStore } from './types';
import { useLocale } from 'next-intl';

/**
 * F6: the summary names what the merchant picked, never a translation key. `store.look` is the registry look id
 * (`qamar.atelier`); `store.template` is the skin (`qamar`), which is NOT a look id, so reading the look from it showed
 * "—" for every store. A store with no look yet falls back to its template family's name.
 */
function chosenLookName(
  look: string | null | undefined,
  template: string | null | undefined,
  locale: 'ar' | 'en'
): string {
  const picked = getLook(look);
  if (picked) return picked.name[locale];
  const family = TEMPLATE_FAMILIES.find(f => f.id === template || f.skin === template);
  if (family) return locale === 'ar' ? family.labelAr : family.labelEn;
  return '—';
}

interface LiveResult {
  id: string;
  name: string;
  host: string;
  url: string;
}

export function LiveStep({
  store,
  productCount,
  onBack,
  onGoToBilling,
}: {
  store: OnboardingStore;
  productCount: number;
  onBack: () => void;
  onGoToBilling: () => void;
}) {
  const t = useT('onboarding.flow.live');
  const tFlow = useT('onboarding.flow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [live, setLive] = useState<LiveResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handlePublish() {
    setError('');
    setErrorCode('');
    setPublishing(true);
    const { data, error: apiError } = await apiPost<{ store: LiveResult }>(
      `/api/v1/onboarding/stores/${store.id}/go-live`
    );
    setPublishing(false);
    if (apiError || !data) {
      // 402s carry a localized message (payment method required, trial over, ...).
      setError(
        apiError?.status === 402 && apiError.message ? apiError.message : t('publishFailed')
      );
      setErrorCode(apiError?.code ?? '');
      return;
    }
    setLive(data.store);
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (insecure context); the link is visible anyway.
    }
  }

  if (live) {
    return (
      <div className="space-y-4 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t('doneTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('doneBody')}</p>
        <a
          href={live.url}
          target="_blank"
          rel="noreferrer"
          dir="ltr"
          className="block break-all rounded-lg bg-muted p-3 text-sm font-medium text-primary-ink"
        >
          {live.host}
        </a>
        <div className="grid gap-3 sm:grid-cols-2">
          <a href={live.url} target="_blank" rel="noreferrer">
            <Button type="button" className="w-full">
              {t('visit')}
            </Button>
          </a>
          <Button type="button" variant="outline" onClick={() => handleCopy(live.url)}>
            {copied ? t('copied') : t('copy')}
          </Button>
          <a
            href={waMeShareLink(
              buildStoreShareMessage({
                locale: resolveDefaultLanguage(undefined),
                storeName: live.name,
                url: live.url,
              })
            )}
            target="_blank"
            rel="noreferrer"
            className="sm:col-span-2"
          >
            <Button type="button" variant="outline" className="w-full">
              {t('whatsapp')}
            </Button>
          </a>
        </div>
        <Link
          href={`/stores/${live.id}`}
          className="block text-sm text-primary-ink hover:underline"
        >
          {t('dashboard')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p dir="auto" className="text-sm text-muted-foreground">
          {t('subtitle', { host: store.host })}
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          <p>{error}</p>
          {errorCode === 'PAYMENT_METHOD_REQUIRED' && (
            <button
              type="button"
              onClick={onGoToBilling}
              className="mt-2 font-medium text-primary-ink underline"
            >
              {t('addPayment')}
            </button>
          )}
        </div>
      )}
      <dl className="divide-y divide-border rounded-lg border border-border text-sm">
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground">{t('checklistName')}</dt>
          <dd className="font-medium text-foreground">{store.name}</dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground">{t('checklistTemplate')}</dt>
          <dd className="font-medium text-foreground">
            {chosenLookName(store.look, store.template, locale)}
          </dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground">{t('checklistProduct')}</dt>
          <dd className="font-medium text-foreground">
            {productCount > 0 ? productCount : t('noProducts')}
          </dd>
        </div>
      </dl>
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button type="button" className="flex-1" disabled={publishing} onClick={handlePublish}>
          {publishing ? t('publishing') : t('publish')}
        </Button>
      </div>
    </div>
  );
}
