'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { NavMenuEditor } from '../../../../components/NavMenuEditor';
import { useT } from '@/i18n/useT';

/**
 * Standalone navigation editor page (/stores/[id]/navigation).
 *
 * The editor body lives in <NavMenuEditor variant="standalone"> which is
 * also reused inside the Page Builder (variant="embedded"). Both surfaces
 * edit the same settings.navMenu field via PUT /api/v1/stores/:id.
 *
 * This page keeps its URL alive so existing bookmarks / links don't 404.
 */
export default function StoreNavigationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('navigation.page');

  return (
    <AdminLayout title={t('title')}>
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={`/stores/${storeId}`} className="hover:text-primary">
            {t('breadcrumbStore')}
          </Link>
          <span>/</span>
          <Link href={`/stores/${storeId}/settings`} className="hover:text-primary">
            {t('breadcrumbSettings')}
          </Link>
          <span>/</span>
          <span className="text-foreground">{t('breadcrumbNav')}</span>
        </div>

        {/* Cross-link to page-builder where navigation is now also embedded */}
        <div className="mb-6">
          <Link
            href={`/stores/${storeId}/page-builder`}
            className="inline-flex items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10"
          >
            ↗ Navigation is also available inside Page Builder
          </Link>
        </div>

        <h1 className="text-2xl font-bold text-foreground">{t('heading')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('helpBefore')}
          <code className="rounded bg-muted px-1">{t('helpCode')}</code>
          {t('helpAfter')}
        </p>

        <div className="mt-8">
          <NavMenuEditor storeId={storeId} variant="standalone" />
        </div>
      </div>
    </AdminLayout>
  );
}
