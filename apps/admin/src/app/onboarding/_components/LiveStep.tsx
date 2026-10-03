'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { whatsappShareUrl } from '@force/shared';
import { apiPost } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import type { OnboardingStore } from './types';

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
}: {
  store: OnboardingStore;
  productCount: number;
  onBack: () => void;
}) {
  const t = useT('onboarding.flow.live');
  const tFlow = useT('onboarding.flow');
  const tTemplates = useT('onboarding.flow.template');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState<LiveResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function handlePublish() {
    setError('');
    setPublishing(true);
    const { data, error: apiError } = await apiPost<{ store: LiveResult }>(
      `/api/v1/onboarding/stores/${store.id}/go-live`
    );
    setPublishing(false);
    if (apiError || !data) {
      setError(t('publishFailed'));
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
            href={whatsappShareUrl(live.url, t('whatsappText'))}
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
          {error}
        </div>
      )}
      <dl className="divide-y divide-border rounded-lg border border-border text-sm">
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground">{t('checklistName')}</dt>
          <dd className="font-medium text-foreground">{store.name}</dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground">{t('checklistTemplate')}</dt>
          <dd className="font-medium text-foreground">{tTemplates(store.template)}</dd>
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
