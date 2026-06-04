import { redirect } from 'next/navigation';

/**
 * The standalone navigation editor was removed — navigation is now edited
 * ONLY inside the Page Builder ("Storefront Navigation" card) and saved by
 * the page-builder's main Save button. This route redirects old bookmarks
 * there so nothing 404s.
 */
export default async function StoreNavigationRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/stores/${id}/page-builder`);
}
