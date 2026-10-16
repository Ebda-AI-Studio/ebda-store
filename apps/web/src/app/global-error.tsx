'use client';

import { BRAND } from '@ebda/shared';

export default function GlobalError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);

  return (
    <html lang={lang}>
      <body className="m-0 font-sans">
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h2 className="mb-2 text-2xl font-semibold">{t('Something went wrong', 'حدث خطأ ما')}</h2>
          <p className="mb-8 max-w-md text-muted-foreground">
            {t(
              'An unexpected error occurred. Please try again.',
              'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.'
            )}
          </p>
          <button
            onClick={reset}
            className="cursor-pointer rounded-lg border-none px-6 py-2.5 text-sm font-medium text-white hover:opacity-90"
            style={{ backgroundColor: BRAND.colors.night }}
          >
            {t('Try Again', 'حاول مرة أخرى')}
          </button>
        </div>
      </body>
    </html>
  );
}
