'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import { FooterLinksEditor } from '../../../../components/FooterLinksEditor';

/**
 * Footer links + utility bar + bottom bar editor.
 *
 * 2026-05-21 refactor: the actual editor body lives in
 * <FooterLinksEditor> (apps/admin/src/components/FooterLinksEditor.tsx)
 * and is reused inside the page-builder Footer card so merchants can
 * edit links from either surface. This file is a thin AdminLayout
 * wrapper with the page chrome (title / back-to-settings / cross-link
 * to page-builder footer chrome).
 */
export default function StorePagesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('pages.page');

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Link href={`/stores/${storeId}/settings`}>
          <Button type="button" variant="outline">
            {t('backToSettings')}
          </Button>
        </Link>
      }
    >
      <div className="space-y-6">
        {/* Cross-link to page-builder Footer chrome card. The two
            surfaces work together: this page owns footer LINKS,
            page-builder Footer card owns footer CHROME (bg, dividers,
            typography). The same editor renders in both places. */}
        <Link
          href={`/stores/${storeId}/page-builder`}
          className="inline-flex items-center gap-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10"
        >
          ↗ Footer chrome (background, dividers, typography) is in Page Builder
        </Link>
        <FooterLinksEditor storeId={storeId} variant="standalone" />
      </div>
    </AdminLayout>
  );
}
