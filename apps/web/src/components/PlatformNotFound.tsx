'use client';

import { PLATFORM_MARKETING_URL } from '../lib/platform';
import { useLanguage, translations } from '../contexts/LanguageContext';

/**
 * 404 for the bare platform host (`store.force-ai.co/<unknown-slug>`).
 *
 * This used to render the full platform marketing landing. It no longer does:
 * that page moved to force-ai.co, and serving it here gave every unknown URL a
 * 200-looking marketing page competing with the real site.
 *
 * It stays a real 404 rather than a redirect — a redirect on a non-existent URL
 * is a soft-404, and search engines treat it as one.
 *
 * A MERCHANT's 404 never reaches this component; `app/not-found.tsx` routes
 * store context to `StoreNotFound` so a merchant's customer is never shown the
 * platform at all.
 *
 * Bilingual (#1542): the root layout sets `<html dir>` from the
 * `force-language` cookie, so an Arabic visitor reached this page under
 * dir="rtl" with English-only copy. Copy lives in LanguageContext.
 *
 * Contrast (#1541, WCAG 2.1 AA 4.5:1 for 14px text): the CTA is #C04E00
 * (white text 4.85:1, hover #A34200 6.29:1) — brand #FF6E01 behind white
 * text is 2.81:1 — and the eyebrow is neutral-600 (7.81:1, was neutral-400
 * at 2.52:1).
 */
export function PlatformNotFound() {
  const { t } = useLanguage();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-600">404</p>
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
        {t('This page doesn’t exist', translations['This page doesn’t exist'])}
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-neutral-500">
        {t(
          'The store you’re looking for may have moved, or the link may be wrong.',
          translations['The store you’re looking for may have moved, or the link may be wrong.']
        )}
      </p>
      <a
        href={PLATFORM_MARKETING_URL}
        className="mt-8 inline-flex items-center rounded-sm bg-[#C04E00] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#A34200] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      >
        {t('Go to Force AI', translations['Go to Force AI'])}
      </a>
    </main>
  );
}
