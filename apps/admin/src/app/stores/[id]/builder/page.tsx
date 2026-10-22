'use client';

/**
 * /stores/:id/builder — the visual builder (Phase 2). Full-screen, outside
 * AdminLayout (like Shopify's theme editor); AuthProvider still gates it.
 * The classic page builder (/page-builder) stays live until parity.
 */
import { useCallback } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { isPageKind, type PageKind } from '@ebda/shared';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { BuilderEditor } from './_components/BuilderEditor';

export default function BuilderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // `?page=product|collection|cart` opens that page's document (home by default); the URL is the
  // state, so a link, a refresh and the back button all land on the same page.
  const rawPage = search?.get('page');
  const pageKey: PageKind = isPageKind(rawPage) ? rawPage : 'home';
  const goToPage = useCallback(
    (next: PageKind) => {
      const q = new URLSearchParams(search?.toString() ?? '');
      if (next === 'home') q.delete('page');
      else q.set('page', next);
      const qs = q.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, search]
  );
  const { user, isLoading } = useAuth();
  const t = useT('builder');
  if (isLoading || !user)
    return (
      <div
        role="status"
        className="grid h-screen place-items-center bg-background text-sm text-muted-foreground"
      >
        {t('loading')}
      </div>
    );
  return (
    <BuilderEditor key={pageKey} storeId={storeId} pageKey={pageKey} onPageChange={goToPage} />
  );
}
