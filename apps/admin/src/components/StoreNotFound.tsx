'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/Button';
import { AdminLayout } from './AdminLayout';

/** QA-91: the store id in the URL is not a store this user can open. One calm sentence and a way back. */
export function StoreNotFound() {
  const t = useTranslations('stores.notFound');
  return (
    <AdminLayout title="">
      <div className="mx-auto max-w-lg px-4 py-16 text-center" role="alert">
        <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('body')}</p>
        <Link href="/stores" className={`${buttonVariants({ variant: 'default' })} mt-4`}>
          {t('backToStores')}
        </Link>
      </div>
    </AdminLayout>
  );
}
