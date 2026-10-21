import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStore, getStoreOrNotFound } from '../../../../lib/store-resolver';
import { decodeRouteParam } from '../../../../lib/route-params';
import { resolveStorefrontLocale } from '../../../../lib/seo/resolve-locale';
import { loadPanel } from './load-panel';
import { LookPiecesClient } from './LookPiecesClient';

type Params = Promise<{ sectionId: string; blockId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = await params;
  const store = await getStore();
  const loaded = await loadPanel(
    store,
    decodeRouteParam(p.sectionId),
    decodeRouteParam(p.blockId)
  ).catch(() => null);
  // The page's own locale (cookie, else the store's default language), as the body reads it:
  // an Arabic-first store's tab and share title are Arabic (review M-1).
  const locale = await resolveStorefrontLocale(
    (store.settings as Record<string, unknown> | undefined)?.defaultLanguage as string | undefined
  );
  const p0 = loaded?.panel;
  const title =
    (locale === 'ar' ? p0?.titleAr || p0?.title : p0?.title || p0?.titleAr) ||
    (locale === 'ar' ? store.nameAr || store.name : store.name || store.nameAr) ||
    undefined;
  // A panel page duplicates the home page's pieces: never indexed on its own.
  return { title, robots: { index: false, follow: true } };
}

export default async function LookPanelPage({ params }: { params: Params }) {
  const [p, store] = await Promise.all([params, getStoreOrNotFound()]);
  const loaded = await loadPanel(store, decodeRouteParam(p.sectionId), decodeRouteParam(p.blockId));
  if (!loaded) notFound();
  return <LookPiecesClient panel={loaded.panel} pieces={loaded.pieces} />;
}
