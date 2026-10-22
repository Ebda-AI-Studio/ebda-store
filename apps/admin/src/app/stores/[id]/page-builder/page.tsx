import { redirect } from 'next/navigation';
import { builderRedirectPath, type RawSearchParams } from '@/lib/builder-redirect';

/**
 * The form page builder was retired (Task 12); the visual editor owns the storefront design. Old bookmarks and links land in the visual editor
 * (`/stores/:id/builder`) with the `select` / `block` / `field` / `page` deep link kept
 * (Ruling VE-6).
 */
export default async function StorePageBuilderRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  redirect(builderRedirectPath(id, await searchParams));
}
