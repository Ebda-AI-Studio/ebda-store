'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useConsent } from '../contexts/ConsentContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';
import { Sheet } from './ui/Sheet';

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
 * Most regulators (see docs/privacy/data-map.md) accept category-level consent
 * as long as the categories are clearly described and the user can change
 * their mind. Adding per-pixel toggles would be over-engineered for what
 * the law actually requires.
 */
export function CookiePreferencesModal() {
  const { isPreferencesOpen, closePreferences, consent, setConsent } = useConsent();
  const { t, isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  // Local draft state — only commits to the cookie when the user clicks Save.
  const [marketingDraft, setMarketingDraft] = useState(consent?.marketing ?? false);

  // Re-sync draft when modal opens (so closing without save doesn't leak
  // local draft state into the next open).
  useEffect(() => {
    if (isPreferencesOpen) {
      setMarketingDraft(consent?.marketing ?? false);
    }
  }, [isPreferencesOpen, consent]);

  // The shared Sheet primitive (R-04): Escape, backdrop tap, focus in/trap/return,
  // scroll lock, a 44px close.
  return (
    <Sheet
      open={isPreferencesOpen}
      onClose={closePreferences}
      side="center"
      dir={isRtl ? 'rtl' : 'ltr'}
      title={t('Cookie preferences', 'تفضيلات ملفات تعريف الارتباط')}
      closeLabel={t('Close', 'إغلاق')}
      className="border border-border bg-background text-foreground"
      headerClassName="!ps-6 sm:!ps-8 !pt-4 sm:!pt-6"
      titleClassName="text-xl font-semibold text-foreground"
      bodyClassName="px-6 pb-6 sm:px-8 sm:pb-8"
      footer={
        <div className="flex flex-col gap-2 px-6 pb-6 sm:flex-row sm:justify-end sm:gap-3 sm:px-8 sm:pb-8">
          <button
            type="button"
            onClick={closePreferences}
            className="inline-flex items-center justify-center min-h-11 rounded-lg border border-input bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
          >
            {t('Cancel', 'إلغاء')}
          </button>
          <button
            type="button"
            onClick={() => setConsent({ marketing: marketingDraft })}
            className="inline-flex items-center justify-center min-h-11 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('Save preferences', 'حفظ التفضيلات')}
          </button>
        </div>
      }
      footerClassName=""
    >
      <p className="mt-2 text-sm text-muted-foreground">
        {t(
          'Control which cookies this site can use. Essential cookies are always on so the store works correctly.',
          'تحكم بملفات تعريف الارتباط التي يستخدمها هذا الموقع. الملفات الأساسية مفعّلة دائماً لضمان عمل المتجر بشكل صحيح.'
        )}{' '}
        <Link
          href={storeUrl('/privacy')}
          prefetch={false}
          className="underline hover:text-foreground"
        >
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
                  // The thumb starts at the inline-start edge; in Arabic that is the
                  // right, so it travels the other way (rtl:), never off the track.
                  marketingDraft
                    ? 'translate-x-6 rtl:-translate-x-6'
                    : 'translate-x-1 rtl:-translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
