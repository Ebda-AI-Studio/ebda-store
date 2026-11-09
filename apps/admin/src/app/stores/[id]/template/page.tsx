import { redirect } from 'next/navigation';

/**
 * UX:T-1 - one door for the store's look: "شكل المتجر" opens the editor at `/builder`, which already holds the
 * look switcher. The old URL stays valid (bookmarks, palette history) and lands there.
 */
export default async function StoreTemplateRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/stores/${id}/builder`);
}
