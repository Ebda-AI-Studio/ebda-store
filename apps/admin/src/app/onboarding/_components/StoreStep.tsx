'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { validateStoreSlug } from '@ebda/shared';
import { storeCreatedEventId } from '@ebda/shared';
import { apiGet, apiPost } from '../../../lib/api';
import { getEbdaTracker } from '../../../lib/ebda-tracker';
import { suggestSlug } from '../../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';
import type { PlanSelection } from '../../../components/billing/types';
import {
  clearStoredSignupSlug,
  readStoredSignupSlug,
} from '../../../components/onboarding/signup-slug';
import { RequestForm } from '@/components/support/RequestForm';
import type { OnboardingStore, SlugCheck } from './types';

type SlugUi =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; host: string }
  | {
      kind: 'problem';
      key: 'taken' | 'reserved' | 'protected' | 'tooShort' | 'tooLong' | 'invalid';
    };

const REASON_KEY = {
  SLUG_TAKEN: 'taken',
  SLUG_RESERVED: 'reserved',
  SLUG_PROTECTED: 'protected',
  SLUG_TOO_SHORT: 'tooShort',
  SLUG_TOO_LONG: 'tooLong',
  SLUG_INVALID_CHARS: 'invalid',
  SLUG_INVALID_HYPHEN: 'invalid',
} as const;

const DEBOUNCE_MS = 400;

export function StoreStep({
  plan,
  onBack,
  onCreated,
}: {
  /** The plan chosen in the plan step; sent so the trial is billed for it on day 15. */
  plan?: PlanSelection;
  onBack?: () => void;
  onCreated: (store: OnboardingStore, lookApplied: boolean) => void;
}) {
  const tFlow = useT('onboarding.flow');
  const t = useT('onboarding.flow.store');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugUi, setSlugUi] = useState<SlugUi>({ kind: 'idle' });
  // A16: ask Ebda Store staff to release a protected address, or to raise the daily store limit.
  const [ask, setAsk] = useState<'slug' | 'cap' | null>(null);
  // A name carried from a store host's 404 ("Start your store as <slug>"): prefill, still checked live below.
  useEffect(() => {
    const carried = readStoredSignupSlug();
    if (carried) {
      setSlug(carried);
      setSlugTouched(true);
    }
  }, []);
  const [nameError, setNameError] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);
  // Only the newest availability answer may update the UI.
  const latest = useRef(0);

  useEffect(() => {
    if (!slug) {
      setSlugUi({ kind: 'idle' });
      return;
    }
    // Format and reserved list are checked locally (same rules as the API) so
    // an obviously bad address never costs a request.
    const local = validateStoreSlug(slug);
    if (!local.ok) {
      setSlugUi({ kind: 'problem', key: REASON_KEY[local.code] });
      return;
    }
    const ticket = ++latest.current;
    setSlugUi({ kind: 'checking' });
    const timer = setTimeout(async () => {
      const { data, error } = await apiGet<SlugCheck>(
        `/api/v1/onboarding/slug-check?slug=${encodeURIComponent(slug)}`
      );
      if (ticket !== latest.current) return;
      if (error || !data) {
        setSlugUi({ kind: 'idle' });
      } else if (data.available) {
        setSlugUi({ kind: 'available', host: data.host });
      } else {
        setSlugUi({ kind: 'problem', key: REASON_KEY[data.reason] });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [slug]);

  function handleName(value: string) {
    setName(value);
    setNameError('');
    if (!slugTouched) setSlug(suggestSlug(value));
  }

  function handleSlug(value: string) {
    setSlugTouched(true);
    setSlug(value.toLowerCase().replace(/\s+/g, '-'));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    if (!name.trim()) {
      setNameError(t('nameRequired'));
      return;
    }
    if (slugUi.kind !== 'available') return;
    setCreating(true);
    const { data, error } = await apiPost<{ store: OnboardingStore; lookApplied?: boolean }>(
      '/api/v1/onboarding/store',
      {
        name: name.trim(),
        slug,
        language: document.documentElement.dir === 'rtl' ? 'ar' : 'en',
        ...(plan ? { plan: { planCode: plan.planCode, interval: plan.interval } } : {}),
      }
    );
    setCreating(false);
    if (error || !data) {
      if (error?.code === 'SLUG_TAKEN') setSlugUi({ kind: 'problem', key: 'taken' });
      else if (error?.code === 'SLUG_RESERVED') setSlugUi({ kind: 'problem', key: 'reserved' });
      else if (error?.code === 'SLUG_PROTECTED') setSlugUi({ kind: 'problem', key: 'protected' });
      else if (error?.code === 'STORE_DAILY_LIMIT') {
        setFormError(t('dailyLimit'));
        setAsk('cap');
      } else if (error?.code === 'STORE_LIMIT_REACHED') setFormError(t('limit'));
      else setFormError(t('createFailed'));
      return;
    }
    // StoreCreated: same event_id as the server's Conversions API event (dedup).
    getEbdaTracker()?.track('store_created', { eventId: storeCreatedEventId(data.store.id) });
    clearStoredSignupSlug();
    onCreated(data.store, data.lookApplied !== false);
  }

  return (
    <form onSubmit={handleCreate} className="space-y-4" noValidate>
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {formError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {formError}
        </div>
      )}
      <Input
        id="store-name"
        label={t('name')}
        value={name}
        onChange={e => handleName(e.target.value)}
        placeholder={t('namePlaceholder')}
        error={nameError || undefined}
        autoComplete="organization"
      />
      <div>
        <Input
          id="store-slug"
          label={t('slug')}
          dir="ltr"
          value={slug}
          onChange={e => handleSlug(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby="store-slug-status"
        />
        <p id="store-slug-status" role="status" aria-live="polite" className="mt-1 min-h-5 text-sm">
          {slugUi.kind === 'checking' && (
            <span className="text-muted-foreground">{t('checking')}</span>
          )}
          {slugUi.kind === 'available' && (
            <span dir="auto" className="text-success-ink">
              {t('available', { host: slugUi.host })}
            </span>
          )}
          {slugUi.kind === 'problem' && (
            <span className="text-destructive-ink">{t(slugUi.key)}</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{t('slugHelp')}</p>
        {slugUi.kind === 'problem' && slugUi.key === 'protected' && ask !== 'slug' && (
          <Button type="button" variant="outline" className="mt-2" onClick={() => setAsk('slug')}>
            {t('claimAddress')}
          </Button>
        )}
      </div>
      {ask && (
        <div className="rounded-lg border border-border p-4">
          <RequestForm
            mode={ask}
            slug={slug}
            onDone={() => undefined}
            onCancel={() => setAsk(null)}
          />
        </div>
      )}
      <div className="flex gap-3">
        {onBack && (
          <Button type="button" variant="outline" onClick={onBack}>
            {tFlow('back')}
          </Button>
        )}
        <Button type="submit" className="flex-1" disabled={creating || slugUi.kind !== 'available'}>
          {creating ? t('creating') : t('create')}
        </Button>
      </div>
    </form>
  );
}
