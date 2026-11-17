import { storefrontAlternates } from '@/lib/seo/locale-alternates';
import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { HomePageBody } from '@/app/HomePageBody';

// NOTE: no `generateStaticParams` here — deliberate, see the layout's
// `dynamicParams` comment and
// docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.4 (explicit ban).

// See the identical comment in `app/page.tsx` — the parent `[locale]/layout.tsx`'s
// `generateMetadata` deliberately does not set `alternates`, or it leaks the
// home canonical onto every sibling route (about, contact, faq, ...) that
// doesn't set its own.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}): Promise<Metadata> {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);
  return { alternates: await storefrontAlternates(store, '', true) };
}

export default async function StoreHomePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  // Track-A never carries an admin preview-draft token — the middleware's
  // `!isPreviewIframe` gate routes preview traffic around this tree
  // entirely (plan §3.3), so there's no draft to thread through here.
  return <HomePageBody store={store} draftToken={undefined} />;
}
