'use client';

import Link from 'next/link';

export default function NotFound() {
  const lang =
    typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <p className="mb-2 text-6xl font-bold text-primary">404</p>
      <h2 className="mb-2 text-2xl font-semibold text-foreground">
        {t('Page not found', 'الصفحة غير موجودة')}
      </h2>
      <p className="mb-8 max-w-md text-muted-foreground">
        {t(
          'The page you are looking for does not exist or has been moved.',
          'الصفحة التي تبحث عنها غير موجودة أو تم نقلها.'
        )}
      </p>
      <Link
        href="/"
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {t('Go Home', 'العودة للرئيسية')}
      </Link>
    </div>
  );
}
