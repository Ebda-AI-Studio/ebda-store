import type { Metadata } from 'next';
import { getStoreByTenantParam } from '@/lib/store-resolver';
import { buildStorefrontMetadata } from '@/lib/storefront-metadata';
import { buildThemeStyleTag } from '@/lib/theme-css';
import { emitZoneCss } from '@/lib/emit-zone-css';
import { organizationJsonLd } from '@/lib/structured-data';
import { localeFromRouteParam } from '@/lib/seo/resolve-locale';
import { JsonLd } from '@/components/JsonLd';
import { ConsentGatedMarketingPixels } from './ConsentGatedMarketingPixels';

/**
 * Track-A (tenant-cacheable) nested layout — Phase 1 of
 * docs/plans/2026-07-12-tenant-cacheable-routing.md §3.6.
 *
 * Dark-launched: this whole `tenant-store/[tenant]/[locale]` tree is only ever
 * reached when `middleware.ts`'s `STOREFRONT_TENANT_ROUTING` rewrite is on
 * (never in Phase 1 — see the plan §9 and the PR body). Unlike the legacy
 * `app/layout.tsx`, this layout resolves the store from the matched
 * `[tenant]` ROUTE PARAM via `getStoreByTenantParam()` — no `headers()` /
 * `cookies()` calls — so it participates in Next's Full Route Cache instead
 * of unconditionally forcing every route dynamic.
 *
 * `[locale]` is resolved by the middleware (from the `force-language`
 * cookie, before the rewrite) and baked into the path — this layout doesn't
 * need to read it as a cookie itself; Next hands it in as `params.locale`.
 *
 * Scope note (see PR body for the full discrepancy writeup): this layout
 * does NOT re-declare the legacy tree's provider stack (StoreProvider /
 * CartProvider / AuthProvider / ConsentProvider / etc.) — Next requires
 * exactly one root layout for the whole `app/` tree, so this nested layout
 * is still wrapped by the (deliberately untouched, for the Phase-1
 * byte-diff gate) legacy `app/layout.tsx`, which already supplies that
 * provider tree via its own header-based resolution. Splitting the
 * provider stack out from the legacy root layout so Track-A truly stops
 * inheriting Dynamic-API calls from an ancestor is the follow-up
 * root-layout-decomposition work called out in the PR body — deferred out
 * of this dark-launched Phase 1 PR given its size/blast-radius (it would
 * require relocating every existing flat route into a route group).
 */

// Explicit, permanent ban — do NOT add `generateStaticParams` to this
// segment or any segment under it. Plan §3.4: eager enumeration here would
// re-couple render mode to build-time DB reachability, the exact failure
// mode documented in the `feedback-migrate-before-deploy-and-force-dynamic`
// incident. `dynamicParams: true` (Next's default, stated explicitly for
// documentation) means every tenant/locale/path combination renders
// on-demand on first request and is cached thereafter.
export const dynamicParams = true;

interface StoreLayoutParams {
  tenant: string;
  locale: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<StoreLayoutParams>;
}): Promise<Metadata> {
  const { tenant } = await params;
  const store = await getStoreByTenantParam(tenant);

  // Custom-domain detection from the ROUTE PARAM instead of the `host`
  // header (plan §3.6) — `tenant` is a bare normalized domain string for
  // custom-domain stores, or `slug:<slug>` for platform-path stores, never
  // both, so the prefix check is a complete, unambiguous signal.
  const isOnCustomDomain = !tenant.startsWith('slug:');

  return buildStorefrontMetadata(store, isOnCustomDomain);
}

export default async function StoreLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<StoreLayoutParams>;
}) {
  const { tenant, locale: localeParam } = await params;
  const store = await getStoreByTenantParam(tenant);
  const locale = localeFromRouteParam(localeParam);

  // Theme CSS injection — shared builder with the legacy layout (see
  // lib/theme-css.ts) so both trees paint an identical theme.
  const themeStyleTag = buildThemeStyleTag(store.theme);
  // Per-zone typography overrides — shared emitter with the legacy layout's
  // draft-preview path (lib/emit-zone-css.ts). Track-A has no draft concept
  // (preview bypasses this tree entirely), so this always reflects the
  // committed store typography.
  const typographyCss = store.typography
    ? emitZoneCss(store.typography as Parameters<typeof emitZoneCss>[0], store.theme)
    : '';
  const combinedStyleTag = [themeStyleTag, typographyCss].filter(Boolean).join('\n');

  const orgJsonLd = organizationJsonLd(store, locale);

  return (
    <>
      {combinedStyleTag && <style dangerouslySetInnerHTML={{ __html: combinedStyleTag }} />}
      <JsonLd data={orgJsonLd} />
      {/* Consent option (a), dormant while STOREFRONT_TENANT_ROUTING is off
          — see ConsentGatedMarketingPixels.tsx for the full writeup. */}
      <ConsentGatedMarketingPixels pixels={store.marketingPixels} />
      {children}
    </>
  );
}
