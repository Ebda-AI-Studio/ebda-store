import { redirect } from 'next/navigation';

/**
 * The standalone hero editor was retired (2026-06-09). The hero is now edited
 * ONLY inside the Page Builder (`layout.hero.slides[]`) and saved by the page
 * builder's main Save button. The legacy per-store hero columns
 * (heroTitle / heroSubtitle / heroCta* / heroImage) are preserved as the
 * storefront's empty-state fallback, and a one-time migration
 * (`packages/database/scripts/migrate-legacy-hero-to-slide.mjs`) seeds a slide
 * from those columns for any store that had no slide yet, so nothing the
 * merchant typed in `/hero` is lost. This route redirects old bookmarks to the
 * Page Builder so nothing 404s — same pattern as `/navigation` + `/pages`.
 */
export default async function StoreHeroRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/stores/${id}/page-builder`);
}
