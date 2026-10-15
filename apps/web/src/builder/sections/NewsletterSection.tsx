'use client';

/**
 * `newsletter` (visual builder Phase 2, document-only section): an email
 * signup posting to the EXISTING store-scoped flow
 * (`POST /public/newsletter/subscribe`, source `section`, idempotent, never
 * reveals list membership).
 *
 * Consent: the line under the form is PLATFORM copy (LanguageContext), not a
 * merchant setting, so no store can ship a signup without it; it links the
 * store's privacy page. It deliberately does NOT promise a one-click
 * unsubscribe: campaign emails carry one, the legacy `/newsletter/broadcast`
 * does not (Ruling BUILDER2-NEWSLETTER-1). Disabled in the editor canvas (no
 * real signups from a preview).
 */
import React, { useState } from 'react';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { api } from '../../lib/api';
import type { SectionPaddingMaxWidthVisibility } from '@ebda/shared';

export interface NewsletterSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  body?: string;
  bodyAr?: string;
  buttonText?: string;
  buttonTextAr?: string;
  bgColor?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewsletterSection({
  settings,
  editorMode = false,
}: {
  settings: NewsletterSettings;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const tr = (k: keyof typeof translations) => t(k, translations[k]);
  const pick = (en?: string, arv?: string) => (ar ? arv || en : en || arv) || '';
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'invalid' | 'error'>('idle');
  const spacing = sectionSpacingClasses(settings, store.look);
  const edit = (key: string) =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : {};

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editorMode) return;
    if (!EMAIL_RE.test(email.trim())) return setState('invalid');
    setState('busy');
    try {
      const res = await api.subscribeNewsletter({
        email: email.trim(),
        language: ar ? 'ar' : 'en',
        source: 'section',
      });
      setState(res.success === false ? 'error' : 'done');
    } catch {
      setState('error');
    }
  };

  const heading = pick(settings.heading, settings.headingAr);
  const body = pick(settings.body, settings.bodyAr);
  const button = pick(settings.buttonText, settings.buttonTextAr) || tr('Subscribe');

  return (
    <section
      data-section="newsletter"
      className={`bg-[hsl(var(--bg-section-alt))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={`${spacing.innerContainerClass} max-w-2xl text-center`}>
        {heading && (
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            {...edit('heading')}
          >
            {heading}
          </h2>
        )}
        {body && (
          <p className="mt-2 text-base text-muted-foreground" {...edit('body')}>
            {body}
          </p>
        )}
        {state === 'done' ? (
          <p role="status" className="mt-5 text-sm font-medium text-foreground">
            {tr('Thanks — you are subscribed.')}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 flex flex-col gap-2 sm:flex-row" noValidate>
            <label className="sr-only" htmlFor="newsletter-section-email">
              {tr('Your email')}
            </label>
            <input
              id="newsletter-section-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              dir="ltr"
              required
              value={email}
              disabled={editorMode}
              onChange={e => {
                setEmail(e.target.value);
                if (state !== 'idle') setState('idle');
              }}
              placeholder={tr('Your email')}
              className="min-h-[44px] min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-background px-3 text-base text-foreground sm:text-sm"
            />
            <button
              type="submit"
              disabled={editorMode || state === 'busy'}
              className="min-h-[44px] rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              {...edit('buttonText')}
            >
              {state === 'busy' ? tr('Subscribing…') : button}
            </button>
          </form>
        )}
        {state === 'invalid' && (
          <p role="alert" className="mt-2 text-sm text-destructive-ink">
            {tr('Please enter a valid email.')}
          </p>
        )}
        {state === 'error' && (
          <p role="alert" className="mt-2 text-sm text-destructive-ink">
            {tr('Something went wrong. Please try again later.')}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {tr('By subscribing you agree to receive marketing emails from this store.')}{' '}
          <a href={storeUrl('/privacy')} className="underline">
            {tr('Privacy policy')}
          </a>
        </p>
      </div>
    </section>
  );
}
