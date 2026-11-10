'use client';
import { Button } from '@/components/ui/Button';

// NOTE: This is Next.js's last-resort error boundary — it replaces the entire
// <html> shell when the root layout itself fails. NextIntlClientProvider lives
// in layout.tsx, so it isn't mounted here and we CANNOT call useT() or any
// next-intl hook. Instead, we read the `admin-lang` cookie inline (set by the
// Language Switcher server-side, cookie name shared with @/i18n/config) and
// pick copy from a small inline dictionary.

const MESSAGES = {
  en: {
    title: 'Ebda Store error',
    message: 'A critical error occurred in Ebda Store.',
    errorId: (id: string) => `Error ID: ${id}`,
    unknown: 'Unknown error',
    retry: 'Try Again',
    goHome: 'Go to Dashboard',
  },
  ar: {
    title: 'خطأ في ابدأ ستور',
    message: 'حدث خطأ جسيم في ابدأ ستور.',
    errorId: (id: string) => `معرّف الخطأ: ${id}`,
    unknown: 'خطأ غير معروف',
    retry: 'حاول مرة أخرى',
    goHome: 'العودة إلى لوحة التحكم',
  },
} as const;

type Locale = keyof typeof MESSAGES;

function readLocale(): Locale {
  if (typeof document === 'undefined') return 'ar';
  const match = document.cookie.match(/(?:^|;\s*)admin-lang=(en|ar)/);
  return (match?.[1] as Locale) ?? 'ar';
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = readLocale();
  const t = MESSAGES[locale];
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir}>
      <body className="m-0 font-sans">
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h2 className="mb-2 text-2xl font-semibold">{t.title}</h2>
          <p className="mb-4 max-w-md text-muted-foreground">{t.message}</p>
          {error.digest && (
            <p className="mb-4 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              {t.errorId(error.digest)}
            </p>
          )}
          <p className="mb-8 max-w-md break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {error.message || t.unknown}
          </p>
          <div className="flex gap-3">
            <Button type="button" onClick={reset}>
              {t.retry}
            </Button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global-error has no Next.js context */}
            <a
              href="/"
              className="inline-block rounded-lg border border-border px-6 py-2.5 text-sm font-medium text-foreground no-underline hover:bg-muted"
            >
              {t.goHome}
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
