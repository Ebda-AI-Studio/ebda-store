import { redirect } from 'next/navigation';
import { builderRedirectPath, type RawSearchParams } from '@/lib/builder-redirect';

/**
 * The standalone hero editor was retired; the hero is a section in the visual editor. Old bookmarks and links land in the visual editor
 * (`/stores/:id/builder`) with the `select` / `block` / `field` / `page` deep link kept
 * (Ruling VE-6).
 */
export default async function StoreHeroRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  redirect(builderRedirectPath(id, await searchParams));
}
