'use client';

import Link from 'next/link';

/**
 * 404 page rendered for unknown store slugs and unmatched routes on
 * the storefront platform. Branded with Force Media chrome (orange
 * accent + neutral copy) rather than the resolved store's theme,
 * because the resolved store is the `DEFAULT_STORE` placeholder when
 * we land here — surfacing its theme would confuse customers (it
 * looks like the merchant has an empty catalogue).
 */
export default function NotFound() {
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-8 flex h-20 w-20 items-center justify-center rounded-2xl bg-[#ff6e00]">
        <span className="text-3xl font-extrabold text-white">404</span>
      </div>
      <h1 className="mb-3 text-3xl font-bold text-foreground">
        {t('Store not found', 'المتجر غير موجود')}
      </h1>
      <p className="mb-8 max-w-md text-muted-foreground">
        {t(
          "The store you're looking for doesn't exist on Force Media. Double-check the URL or head back to the marketing site.",
          'المتجر الذي تبحث عنه غير موجود على Force Media. تأكد من الرابط أو عُد إلى الموقع الرئيسي.'
        )}
      </p>
      <div className="flex flex-col items-stretch gap-3 sm:flex-row">
        <a
          href="https://forcemediakw.com"
          className="rounded-lg bg-[#ff6e00] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#e66200]"
        >
          {t('Back to forcemediakw.com', 'العودة إلى forcemediakw.com')}
        </a>
        <Link
          href="/"
          className="rounded-lg border px-6 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('Storefront home', 'الصفحة الرئيسية')}
        </Link>
      </div>
    </div>
  );
}
