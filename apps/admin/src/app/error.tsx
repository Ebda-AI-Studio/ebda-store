'use client';

import { Button, buttonVariants } from '@/components/ui/Button';
import Link from 'next/link';
import { useEffect } from 'react';
import { useT } from '@/i18n/useT';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT('common.errors.boundary');
  // The JS message is for developers (console), never for the merchant.
  useEffect(() => {
    console.error('[admin] app crashed', error);
  }, [error]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="force-card max-w-lg w-full py-12 text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-lg bg-destructive/5">
          <svg
            className="h-10 w-10 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-semibold text-foreground">{t('title')}</h2>
        <p className="mb-4 text-muted-foreground">{t('message')}</p>
        {error.digest && (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {t('errorId', { id: error.digest })}
          </p>
        )}
        <div className="flex justify-center gap-3">
          <Button type="button" onClick={reset}>
            {t('retry')}
          </Button>
          <Link href="/" className={buttonVariants({ variant: 'outline' })}>
            {t('goHome')}
          </Link>
        </div>
      </div>
    </div>
  );
}
