'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';

export default function NotFound() {
  const t = useT('common.errors.notFound');
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="force-card max-w-lg w-full py-12 text-center">
        <p className="mb-2 text-6xl font-bold text-primary">{t('code')}</p>
        <h2 className="mb-2 text-xl font-semibold text-foreground">{t('title')}</h2>
        <p className="mb-8 text-muted-foreground">{t('message')}</p>
        <Link
          href="/"
          className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t('goHome')}
        </Link>
      </div>
    </div>
  );
}
