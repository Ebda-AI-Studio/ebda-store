import { redirect } from 'next/navigation';

/**
 * The standalone "Footer & utility" editor was removed — footer + utility
 * links are now edited ONLY inside the Page Builder ("Footer & utility" card)
 * and saved by the page-builder's main Save button. This route redirects old
 * bookmarks there so nothing 404s.
 */
export default async function StoreFooterLinksRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/stores/${id}/page-builder`);
}
