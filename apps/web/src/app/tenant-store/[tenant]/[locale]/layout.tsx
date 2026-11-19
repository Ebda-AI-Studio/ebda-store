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
 * docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.6.
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
  // While the root layout owns the store chrome it also owns the document
  // metadata, and Next lets a nested layout's metadata REPLACE the root's.
  // This tree's `[locale]` segment is baked by middleware from the cookie alone
  // (cookie-less visitors and crawlers get `en`), whereas the root resolves
  // cookie -> store defaultLanguage -> en. On an Arabic-default store that gave
  // an English <title>/og:locale over an Arabic <html lang> (issue 2407). Emit
  // nothing so the root's metadata is the only writer, identical flag on/off.
  // Guarded by tests/unit/web-tenant-tree-store-chrome-render.test.tsx.
  if (ROOT_LAYOUT_OWNS_STORE_CHROME) return {};

  const { tenant, locale } = await params;
  const store = await getStoreByTenantParam(tenant);

  // Custom-domain detection from the ROUTE PARAM instead of the `host`
  // header (plan §3.6) — `tenant` is a bare normalized domain string for
  // custom-domain stores, or `slug:<slug>` for platform-path stores, never
  // both, so the prefix check is a complete, unambiguous signal.
  const isOnCustomDomain = !tenant.startsWith('slug:');

  return buildStorefrontMetadata(store, isOnCustomDomain, localeFromRouteParam(locale));
}

/**
 * Whether the legacy root `app/layout.tsx` still renders the per-store chrome
 * (theme `<style>`, Organization JSON-LD, SSR consent-gated marketing pixels)
 * for this tree. It does — this tree is nested INSIDE it until the root-layout
 * decomposition (plan §3.6) lands — so this layout must not emit that chrome a
 * second time. Measured on the Phase-2 CF preview (2026-09-25) with the flag on:
 *
 * - pixels: a second `MarketingPixelsProvider` runs its own PageView effect, so
 *   every Meta/TikTok/Snap/X/Pinterest PageView fires twice for consenting
 *   visitors (double-counted conversions);
 * - JSON-LD: 4 ld+json blocks instead of 3 (a duplicate Organization node, in
 *   the route locale rather than the visitor's resolved language);
 * - `<style>`: `emitZoneCss` does NOT match the root layout's typography
 *   emitter (it leaves `brand-foreground` unresolved, drops the `!important`
 *   on `text-decoration:none`, and puts an `@import` after other rules), and
 *   being later in the document it would win cascade ties on demo-merchant.
 *
 * ONE layer owns each write: the root layout, for now. Flip this to `false` in
 * the same change that removes that chrome from the root layout for this tree
 * (and reconcile `emitZoneCss` with the root emitter first). Guarded by
 * tests/unit/web-tenant-tree-single-pixel-writer.test.ts.
 */
const ROOT_LAYOUT_OWNS_STORE_CHROME: boolean = true;

export default async function StoreLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<StoreLayoutParams>;
}) {
  const { tenant, locale: localeParam } = await params;
  // Resolved before the ownership check so an unknown tenant fails here the
  // same way either way.
  const store = await getStoreByTenantParam(tenant);
  if (ROOT_LAYOUT_OWNS_STORE_CHROME) return <>{children}</>;

  const locale = localeFromRouteParam(localeParam);

  // Theme CSS injection — shared builder with the legacy layout (see
  // lib/theme-css.ts) so both trees paint an identical theme.
  const themeStyleTag = buildThemeStyleTag(store.theme, store.look);
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
      {/* Consent option (a) — only reached once ROOT_LAYOUT_OWNS_STORE_CHROME
          is false; see ConsentGatedMarketingPixels.tsx for the full writeup. */}
      <ConsentGatedMarketingPixels pixels={store.marketingPixels} />
      {children}
    </>
  );
}
