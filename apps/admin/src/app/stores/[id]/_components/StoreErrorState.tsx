'use client';

import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import type { StoreLoadError } from '../_hooks/useDashboardData';
import { Button } from '@/components/ui/Button';

interface StoreErrorStateProps {
  storeError: StoreLoadError;
  onRetry: () => void;
}

export function StoreErrorState({ storeError, onRetry }: StoreErrorStateProps) {
  const t = useT('stores.dashboard');
  const isNotFound = storeError === 'not_found';
  return (
    <AdminLayout
      title={isNotFound ? t('notFoundTitle') : t('errorTitle')}
      subtitle={isNotFound ? t('notFoundSubtitle') : t('errorSubtitle')}
    >
      <div className="text-center py-12 space-y-4">
        {!isNotFound && (
          <Button variant="default" size="md" type="button" onClick={onRetry}>
            {t('retry')}
          </Button>
        )}
        <div>
          <Link href="/stores" className="text-primary hover:underline text-sm">
            {t('backToStores')}
          </Link>
        </div>
      </div>
    </AdminLayout>
  );
}
