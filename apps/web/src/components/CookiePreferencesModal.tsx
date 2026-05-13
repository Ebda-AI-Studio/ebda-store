'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useConsent } from '../contexts/ConsentContext';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Cookie preferences modal — granular consent toggles. Triggered from:
 *   1. CookieConsentBanner "Customize" button (first-time visit)
 *   2. Footer "Cookie preferences" link (re-visit / change mind)
 *
 * Categories at v1:
 *   - Essential — always on, can't disable (language, cart, auth, CSRF)
 *   - Marketing — Meta / GA4 / Google Ads / TikTok / Snapchat / Twitter / Pinterest
 *
 * Granular pixel-by-pixel toggles are deliberately out of scope at v1.
 * Most regulators (incl. Kuwait Law 13/2023) accept category-level consent
 * as long as the categories are clearly described and the user can change
 * their mind. Adding per-pixel toggles would be over-engineered for what
 * the law actually requires.
 */
export function CookiePreferencesModal() {
  const { isPreferencesOpen, closePreferences, consent, setConsent } = useConsent();
  const { t, isRtl } = useLanguage();
  // Local draft state — only commits to the cookie when the user clicks Save.
  const [marketingDraft, setMarketingDraft] = useState(consent?.marketing ?? false);

  // Re-sync draft when modal opens (so closing without save doesn't leak
  // local draft state into the next open).
  useEffect(() => {
    if (isPreferencesOpen) {
      setMarketingDraft(consent?.marketing ?? false);
    }
  }, [isPreferencesOpen, consent]);

  // ESC closes the modal.
  useEffect(() => {
    if (!isPreferencesOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreferences();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPreferencesOpen, closePreferences]);

  if (!isPreferencesOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-prefs-title"
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Backdrop — click to close */}
      <button
        type="button"
        aria-label={t('Close preferences', 'إغلاق التفضيلات')}
        onClick={closePreferences}
        className="absolute inset-0 bg-black/50"
      />

      {/* Modal panel */}
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-2xl sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <h2 id="cookie-prefs-title" className="text-xl font-semibold text-foreground">
            {t('Cookie preferences', 'تفضيلات ملفات تعريف الارتباط')}
          </h2>
          <button
            type="button"
            onClick={closePreferences}
            aria-label={t('Close', 'إغلاق')}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'Control which cookies this site can use. Essential cookies are always on so the store works correctly.',
            'تحكم بملفات تعريف الارتباط التي يستخدمها هذا الموقع. الملفات الأساسية مفعّلة دائماً لضمان عمل المتجر بشكل صحيح.'
          )}{' '}
          <Link href="/privacy" prefetch={false} className="underline hover:text-foreground">
            {t('Read privacy policy', 'اقرأ سياسة الخصوصية')}
          </Link>
        </p>

        <div className="mt-6 space-y-4">
          {/* Essential — always on, disabled toggle */}
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="font-medium text-foreground">{t('Essential', 'أساسية')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    'Required for the store to work — language, cart, login, security. Always on.',
                    'مطلوبة لعمل المتجر — اللغة، سلة التسوق، تسجيل الدخول، الأمان. مفعّلة دائماً.'
                  )}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                {t('Always on', 'مفعّل دائماً')}
              </span>
            </div>
          </div>

          {/* Marketing — togglable */}
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="font-medium text-foreground">{t('Marketing', 'تسويقية')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t(
                    'Tracks visits across our site and ad platforms (Meta, TikTok, Google, etc.) to measure ads and show you relevant offers.',
                    'تتبع زياراتك في موقعنا ومنصات الإعلانات (ميتا، تيك توك، جوجل، إلخ) لقياس الإعلانات وعرض عروض ذات صلة.'
                  )}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={marketingDraft}
                onClick={() => setMarketingDraft(v => !v)}
                className={`relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                  marketingDraft ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span className="sr-only">
                  {t('Toggle marketing cookies', 'تبديل ملفات التسويق')}
                </span>
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                    marketingDraft
                      ? isRtl
                        ? 'translate-x-1'
                        : 'translate-x-6'
                      : isRtl
                        ? 'translate-x-6'
                        : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={closePreferences}
            className="inline-flex items-center justify-center min-h-11 rounded-lg border border-border bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            {t('Cancel', 'إلغاء')}
          </button>
          <button
            type="button"
            onClick={() => setConsent({ marketing: marketingDraft })}
            className="inline-flex items-center justify-center min-h-11 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
          >
            {t('Save preferences', 'حفظ التفضيلات')}
          </button>
        </div>
      </div>
    </div>
  );
}
