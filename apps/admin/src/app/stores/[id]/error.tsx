'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '@/components/AdminLayout';
import { PlanLockedCard } from '@/components/PlanLockedCard';
import { isPlanGateError } from '@/lib/route-feature-gates';

/**
 * Per-page error boundary for every /stores/[id]/* route. A crash in ONE page keeps the shell (sidebar, hub tabs, top bar,
 * bottom bar), so the merchant can navigate away, instead of replacing the whole app with the root boundary.
 * Never prints the JS message (it goes to the console for developers); a thrown plan refusal renders the upgrade card.
 */
export default function StoreRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string; status?: number; code?: string };
  reset: () => void;
}) {
  const t = useT('common.errors.boundary');
  const params = useParams();
  const storeId = typeof params?.id === 'string' ? params.id : '';

  useEffect(() => {
    console.error('[admin] page crashed', error);
  }, [error]);

  const planGate = isPlanGateError(error);

  return (
    <AdminLayout title="" storeId={storeId || undefined}>
      {planGate ? (
        <PlanLockedCard
          info={{ status: error.status as number, code: error.code ?? '' }}
          message=""
        />
      ) : (
        <div className="flex min-h-[50vh] items-center justify-center px-4 py-10">
          <div className="w-full max-w-lg rounded-lg border border-border bg-card p-8 text-center shadow-sm">
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('title')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">{t('message')}</p>
            {error.digest && (
              <p className="mb-4 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-ink">
                {t('errorId', { id: error.digest })}
              </p>
            )}
            <div className="flex justify-center gap-3">
              <Button type="button" onClick={reset}>
                {t('retry')}
              </Button>
              <Link
                href={storeId ? `/stores/${encodeURIComponent(storeId)}` : '/'}
                className={buttonVariants({ variant: 'outline' })}
              >
                {t('goHome')}
              </Link>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
