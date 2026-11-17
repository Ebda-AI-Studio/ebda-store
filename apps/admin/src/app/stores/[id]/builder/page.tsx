'use client';

/**
 * /stores/:id/builder — the visual builder (Phase 2). Full-screen, outside
 * AdminLayout (like Shopify's theme editor); AuthProvider still gates it.
 * The classic form builder is retired: its old route and /hero, /navigation, /pages redirect
 * here, keeping the deep link (Ruling VE-6).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { isPageKind, type PageKind } from '@ebda/shared';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { BuilderEditor } from './_components/BuilderEditor';
import { parseDeepLink } from './_lib/deeplink';
import { builderNeedsDocumentReload } from '@/lib/csp';

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
      // A deep link names a place on ONE page; it must not follow the merchant to the next.
      for (const k of ['select', 'block', 'field']) q.delete(k);
      const qs = q.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, search]
  );
  const deepLink = useMemo(() => parseDeepLink(search), [search]);
  // The document CSP (frame-src) is fixed at first load; see builderNeedsDocumentReload.
  useEffect(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    if (builderNeedsDocumentReload(nav?.name, window.location.href)) window.location.reload();
  }, []);
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
    <BuilderEditor
      key={pageKey}
      storeId={storeId}
      pageKey={pageKey}
      onPageChange={goToPage}
      deepLink={deepLink}
    />
  );
}
