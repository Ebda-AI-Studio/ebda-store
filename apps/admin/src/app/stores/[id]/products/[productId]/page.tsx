import { redirect } from 'next/navigation';

/**
 * The read-only product page was folded into the edit page's "overview" tab (UX:PE-3). The old URL stays valid and
 * lands on that tab; `returnTo` is kept so the way back to the filtered list still works.
 */
export default async function ProductViewRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; productId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { id, productId } = await params;
  const { returnTo } = await searchParams;
  const qs = new URLSearchParams({ tab: 'overview' });
  const rt = Array.isArray(returnTo) ? returnTo[0] : returnTo;
  if (rt) qs.set('returnTo', rt);
  redirect(`/stores/${id}/products/${productId}/edit?${qs}`);
}
