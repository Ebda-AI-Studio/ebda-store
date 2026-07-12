import { getStoreByTenantParam } from '@/lib/store-resolver';
import { HomePageBody } from '@/app/HomePageBody';

// NOTE: no `generateStaticParams` here — deliberate, see the layout's
// `dynamicParams` comment and
// docs/plans/2026-07-12-tenant-cacheable-routing.md §3.4 (explicit ban).

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
