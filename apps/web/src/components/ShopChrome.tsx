'use client';

import { useRouter } from 'next/navigation';
import { useStore, useStoreBranding, useStoreContact, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { withBundlesNavEntry, bundlesNavVisible } from '../lib/bundles-nav';
import { BottomTabBar } from '../templates/shared/BottomTabBar';
import { FloatingWidget } from '../templates/shared/FloatingWidget';
import { SectionDivider, resolveSlotDividerSettings } from '../templates/shared/SectionDivider';
import { resolveFooterAutoContrastBg } from '../lib/footer-logo-bg';
import type { FloatingWidgetConfig } from '@ebda/shared';
import { resolveColor, footerLogoContrastFilter, sanitizeUrl } from '@ebda/shared';
import type { StoreLayoutSettings } from '@ebda/shared';
import { sectionVisibilityClass } from '../templates/shared/section-spacing';
import { openSearch } from '../lib/search-term-state';
import type {
  FooterBottomBarConfig,
  FooterLinkSection,
  FooterLinksConfig,
  NavItem,
  ResolvedUtilityBar,
} from '../templates/types';
import { ReactNode } from 'react';
import { StickyHeaderOffset } from './StickyHeaderOffset';
import { StickyBrowseCartBar } from './commerce/StickyBrowseCartBar';
import { CardStepperProvider } from '../templates/shared/card-stepper-context';

/**
 * Heights the placeholder reserves until the template chunk arrives, measured on the demo stores at a 393 px
 * viewport (announcement row 41 px; header 68 px on qamar/minimal-style headers). A taller header (souq: 124 px)
 * still moves the page once, by the difference, instead of by the whole header.
 */
const ANNOUNCEMENT_BAR_MIN_PX = 41;
const HEADER_MIN_PX = 68;
/**
 * Header heights of the look stores at 390 px, measured after hydration (2026-10-31, `main` top minus the 41 px
 * announcement row). The placeholder reserves the look's own height, so the page moves by nothing when the real
 * header arrives (Qamar lookbook moved 27 px: CLS 0.100-0.151 on slow 3G, budget 0.1). A look missing here keeps
 * HEADER_MIN_PX. Re-measure when a look's header changes.
 */
const LOOK_HEADER_PX: Record<string, number> = {
  'qamar.atelier': 92,
  'qamar.lookbook': 95,
  'qamar.vitrine': 120,
  'souq.catalogue': 124,
  'souq.night': 75,
  'jasmine.apothecary': 95,
  'jasmine.bloom': 75,
  'lamma.table': 78,
  'lamma.notebook': 75,
  'lamma.market': 75,
  'dahab.worn': 65,
  'dahab.workshop': 65,
  'dahab.giftbox': 65,
};

interface ShopChromeProps {
  children: ReactNode;
  /**
   * Per-page layout settings. When provided (homepage passes from
   * HomePageContent), ShopChrome applies layout.header.{bgColor, sticky}
   * + layout.footer.{bgColor, dividers.above}. Other routes (PDP, catalog,
   * blog) pass undefined and inherit the existing theme-default chrome —
   * homepage-only customization for v1. v2 will fetch layout in
   * StoreContext so every route consistently applies.
   */
  layout?: StoreLayoutSettings;
}

/**
 * The full storefront chrome: template-selected Header + AnnouncementBar +
 * children + Footer. Wrap a page's content in this to get the selected
 * template's look across the whole surface. Only /auth, /checkout, and the
 * public wishlist-share page use MinimalChrome instead.
 */
export function ShopChrome({ children, layout: layoutProp }: ShopChromeProps) {
  const router = useRouter();
  const { store, layout: ctxLayout, draftSettings } = useStore();
  // Prop wins (homepage server-fetches layout for SSR correctness); context
  // layout is the lazy-fetched fallback for other routes.
  const layout = layoutProp ?? ctxLayout ?? undefined;
  // Ruling TEMPLATES-POLISH-1: a look store pins its header like the mock-ups do; an explicit merchant
  // choice (`sticky: false`) still wins, and a store without a look keeps the old default (scrolls away).
  const headerSticky = layout?.header?.sticky ?? Boolean(store?.look);
  const branding = useStoreBranding();
  const contact = useStoreContact();
  const storeUrl = useStoreUrl();
  const { language } = useLanguage();
  const { itemCount } = useCart();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();

  const isRtl = language === 'ar';

  // Store owners can override the navigation menu via store.settings.navMenu
  // (an array of { label, labelAr?, href }). href may be relative ("/about")
  // or absolute ("https://..."); relative hrefs are run through storeUrl() so
  // multi-tenant platform URLs get the right slug prefix. Falls back to the
  // default 4-item menu when the setting is missing or malformed.
  // When a page-builder preview draft is active, prefer draftSettings.navMenu
  // over the committed store.settings so unsaved nav changes preview immediately.
  const defaultNav: NavItem[] = [
    { label: 'Products', labelAr: 'المنتجات', href: storeUrl('/products') },
    { label: 'Categories', labelAr: 'الفئات', href: storeUrl('/categories') },
    { label: 'About', labelAr: 'من نحن', href: storeUrl('/about') },
    { label: 'Contact', labelAr: 'تواصل معنا', href: storeUrl('/contact') },
  ];
  const customNav = draftSettings?.navMenu ?? store.settings?.navMenu;
  const navigation: NavItem[] = Array.isArray(customNav)
    ? customNav
        .filter(
          (item): item is { label: string; labelAr?: string; href: string } =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as { label?: unknown }).label === 'string' &&
            typeof (item as { href?: unknown }).href === 'string'
        )
        .map(item => ({
          label: item.label,
          labelAr: item.labelAr,
          // Scheme-validate every merchant-supplied href before rendering as <a>.
          // sanitizeUrl allows http/https/mailto/tel and site-relative paths;
          // javascript:, data:, vbscript: and other unsafe schemes fall back to '#'.
          href: sanitizeUrl(item.href.startsWith('http') ? item.href : storeUrl(item.href), '#'),
        }))
    : defaultNav;

  // When locationsEnabled is off, suppress any Locations link the merchant may
  // have manually added to nav / footer / utility bar — avoids a live 404 if
  // the merchant placed the link and later toggled the feature off.
  const isLocationsHref = (href: string) =>
    href === storeUrl('/locations') || href.endsWith('/locations');

  // FIX A — safe fallback: if locationsEnabled but no link exists anywhere,
  // auto-append "Locations" to the header nav so it's never silently lost.
  // When the merchant HAS explicitly placed a /locations link in nav, footer
  // columns, or utility bar, do NOT add a duplicate (respect their placement).
  const hasExplicitLocations =
    navigation.some(n => isLocationsHref(n.href)) ||
    (() => {
      const rawFooter = store.settings?.footerLinks;
      if (!rawFooter || typeof rawFooter !== 'object' || Array.isArray(rawFooter)) return false;
      const src = rawFooter as Record<string, unknown>;
      for (const col of ['shop', 'company', 'support'] as const) {
        const section = src[col];
        if (Array.isArray(section)) {
          for (const item of section) {
            if (
              item &&
              typeof item === 'object' &&
              typeof (item as { href?: unknown }).href === 'string' &&
              isLocationsHref((item as { href: string }).href)
            )
              return true;
          }
        }
      }
      return false;
    })() ||
    (() => {
      const rawBar = store.settings?.utilityBar;
      if (!rawBar || typeof rawBar !== 'object' || Array.isArray(rawBar)) return false;
      const barLinks = (rawBar as Record<string, unknown>).links;
      if (!Array.isArray(barLinks)) return false;
      return barLinks.some(
        item =>
          item &&
          typeof item === 'object' &&
          typeof (item as { href?: unknown }).href === 'string' &&
          isLocationsHref((item as { href: string }).href)
      );
    })();

  const baseNavigation: NavItem[] = store.locationsEnabled
    ? navigation
    : navigation.filter(n => !isLocationsHref(n.href));

  const navigationWithLocations: NavItem[] =
    store.locationsEnabled && !hasExplicitLocations
      ? [
          ...baseNavigation,
          {
            label: 'Locations',
            labelAr: 'الفروع',
            href: storeUrl('/locations'),
          },
        ]
      : baseNavigation;

  // "Bundles" nav entry — same auto-append shape as Locations above, read
  // straight off the store-resolve payload.
  //
  // P1-6 (final review): this used to call a `useBundlesNavVisible` hook
  // that issued `GET /stores/public/:storeId/bundles` on mount — from the
  // component that wraps EVERY storefront page, for every store, with no
  // memo and no cache. `bundles` is in no plan baseline, so essentially the
  // entire fleet paid a full round-trip per page view to be told `403
  // FEATURE_DISABLED`, spending budget on both `publicLimiter` and
  // `publicTenantLimiter` for a value that is false. The hook's premise —
  // "no client-visible boolean equivalent" — was simply wrong:
  // `store.enabledFeatures` is already on the resolve payload and already
  // read a few lines below for `floating_widget`. The decision itself stays
  // a pure, unit-tested function (`withBundlesNavEntry`) — see
  // lib/bundles-nav.ts.
  const showBundlesNav = bundlesNavVisible(store.enabledFeatures);
  const filteredNavigation: NavItem[] = withBundlesNavEntry(
    navigationWithLocations,
    showBundlesNav,
    storeUrl('/bundles')
  );

  // Per-store footer columns are saved in `store.settings.footerLinks` by the
  // admin's pages settings UI. Mirror the navMenu treatment: only forward if
  // the saved value is a plain object, drop malformed sections, and rewrite
  // relative hrefs through storeUrl() so multi-tenant platform URLs get the
  // correct slug prefix. Each template handles a missing/empty config by
  // falling back to its built-in default layout.
  // Draft preview: prefer draftSettings.footerLinks when active.
  const rawFooterLinks = draftSettings?.footerLinks ?? store.settings?.footerLinks;
  const footerLinks: FooterLinksConfig | undefined =
    rawFooterLinks && typeof rawFooterLinks === 'object' && !Array.isArray(rawFooterLinks)
      ? (() => {
          const src = rawFooterLinks as Record<string, unknown>;
          const normalizeSection = (value: unknown): FooterLinkSection[] | undefined => {
            if (!Array.isArray(value)) return undefined;
            const items = value
              .filter(
                (
                  item
                ): item is { name: string; href: string; nameAr?: string; enabled?: boolean } =>
                  !!item &&
                  typeof item === 'object' &&
                  typeof (item as { name?: unknown }).name === 'string' &&
                  typeof (item as { href?: unknown }).href === 'string'
              )
              .map(item => ({
                name: item.name,
                nameAr: typeof item.nameAr === 'string' ? item.nameAr : undefined,
                // Scheme-validate every merchant-supplied href — same rule as nav.
                href: sanitizeUrl(
                  item.href.startsWith('http') ? item.href : storeUrl(item.href),
                  '#'
                ),
                enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
              }))
              // Suppress any Locations link when the feature is disabled so a
              // merchant-placed footer link doesn't 404.
              .filter(item => store.locationsEnabled || !isLocationsHref(item.href));
            return items.length ? items : undefined;
          };
          const newsletter =
            typeof src.newsletterEnabled === 'boolean' ? src.newsletterEnabled : undefined;
          // Bottom-bar config (toggles + copyright override). Drop fields
          // that aren't the right type so a corrupted JSON value can't crash
          // the storefront — the resolver in display-helpers picks defaults
          // for any missing key.
          const rawBottomBar = src.bottomBar;
          let bottomBar: FooterBottomBarConfig | undefined;
          if (rawBottomBar && typeof rawBottomBar === 'object' && !Array.isArray(rawBottomBar)) {
            const bb = rawBottomBar as Record<string, unknown>;
            bottomBar = {
              enabled: typeof bb.enabled === 'boolean' ? bb.enabled : undefined,
              copyrightOverride:
                typeof bb.copyrightOverride === 'string' ? bb.copyrightOverride : undefined,
              copyrightOverrideAr:
                typeof bb.copyrightOverrideAr === 'string' ? bb.copyrightOverrideAr : undefined,
              privacyEnabled:
                typeof bb.privacyEnabled === 'boolean' ? bb.privacyEnabled : undefined,
              termsEnabled: typeof bb.termsEnabled === 'boolean' ? bb.termsEnabled : undefined,
              shippingEnabled:
                typeof bb.shippingEnabled === 'boolean' ? bb.shippingEnabled : undefined,
              returnsEnabled:
                typeof bb.returnsEnabled === 'boolean' ? bb.returnsEnabled : undefined,
            };
          }
          return {
            shop: normalizeSection(src.shop),
            company: normalizeSection(src.company),
            support: normalizeSection(src.support),
            newsletterEnabled: newsletter,
            bottomBar,
          };
        })()
      : undefined;

  // Pre-header utility bar (Elegant + Classic packs render one). Saved at
  // `store.settings.utilityBar` by the admin's pages settings UI. Mirror the
  // navMenu / footerLinks treatment: tolerate malformed input, drop links
  // missing required fields, and rewrite relative hrefs through storeUrl()
  // so multi-tenant platform URLs get the correct slug prefix. When the
  // saved value is undefined entirely, leave `utilityBar` undefined so the
  // packs fall back to their built-in default bar (preserves legacy stores
  // that never touched the setting). When the merchant explicitly toggles
  // `enabled: false`, we forward that so the pack hides the bar.
  // Draft preview: prefer draftSettings.utilityBar when active.
  const rawUtilityBar = draftSettings?.utilityBar ?? store.settings?.utilityBar;
  const utilityBar: ResolvedUtilityBar | undefined =
    rawUtilityBar && typeof rawUtilityBar === 'object' && !Array.isArray(rawUtilityBar)
      ? (() => {
          const src = rawUtilityBar as Record<string, unknown>;
          const enabled = typeof src.enabled === 'boolean' ? src.enabled : true;
          const rawLinks = src.links;
          const links = Array.isArray(rawLinks)
            ? rawLinks
                .filter(
                  (
                    item
                  ): item is { label: string; href: string; labelAr?: string; enabled?: boolean } =>
                    !!item &&
                    typeof item === 'object' &&
                    typeof (item as { label?: unknown }).label === 'string' &&
                    typeof (item as { href?: unknown }).href === 'string'
                )
                .map(item => ({
                  label: item.label,
                  labelAr: typeof item.labelAr === 'string' ? item.labelAr : undefined,
                  // Scheme-validate every merchant-supplied href — same rule as nav.
                  href: sanitizeUrl(
                    item.href.startsWith('http') ? item.href : storeUrl(item.href),
                    '#'
                  ),
                  enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
                }))
                // Suppress any Locations link when the feature is disabled so a
                // merchant-placed utility bar link doesn't 404.
                .filter(item => store.locationsEnabled || !isLocationsHref(item.href))
            : [];
          return { enabled, links };
        })()
      : undefined;

  // Address link config lives at `store.settings.contact.{addressUrl,
  // addressLink}` so the admin's Settings → Branding → Contact tab can both
  // (a) supply an explicit map URL the merchant pasted from Google/Apple
  // Maps and (b) toggle whether the address renders as a clickable link.
  // Defaults preserve historic behaviour: link enabled, falls back to a
  // synthesised Google Maps search URL when no explicit URL is set.
  //
  // Legacy stores may still have the prior `addressLink: 'maps' | 'none'`
  // value persisted; we normalise that to a boolean here so the storefront
  // doesn't need to know about the migration.
  const rawContactSettings = (store.settings?.contact as Record<string, unknown> | undefined) ?? {};
  const rawAddressLink = rawContactSettings.addressLink;
  const addressLink: boolean = rawAddressLink === false || rawAddressLink === 'none' ? false : true;
  const addressUrl: string | undefined =
    typeof rawContactSettings.addressUrl === 'string' && rawContactSettings.addressUrl.trim()
      ? rawContactSettings.addressUrl.trim()
      : undefined;

  const handleSearch = (query: string) => {
    // The term never goes in the URL (Ruling SEARCH-URL-1): it is handed to /search out of band.
    openSearch(query, storeUrl('/search'), url => router.push(url));
  };

  if (templateLoading || !T) {
    // SEO-1 (P14): this placeholder MUST keep `children` at the same tree position, with the same
    // wrapper types, as the real chrome below. It used to return a different tree, so when the template
    // chunk arrived (after hydration, ~7 s on a slow phone) React unmounted the whole page body and
    // mounted a new one: the product <img> was replaced, which Chrome reports as a second, late LCP
    // candidate (6.7-7.8 s) and which shifted everything under the header (CLS). Slot order mirrors the
    // real return: [announcement, header zone, main, ...]. Only the header's CONTENT differs.
    return (
      <CardStepperProvider>
        <div
          className="flex min-h-screen flex-col bg-background"
          data-ui-uppercase={store?.theme?.uppercaseStyle ? 'true' : undefined}
        >
          {/* announcement slot: reserves its row so the bar arriving later does not push the page down */}
          {(layout?.announcement?.enabled ?? store.announcementBar?.enabled) &&
            store.announcementBar?.text &&
            !store.isDemo && (
              <aside
                data-zone="beforeHeader"
                aria-hidden
                className={sectionVisibilityClass(layout?.announcement) ?? undefined}
                style={{ minHeight: ANNOUNCEMENT_BAR_MIN_PX }}
              />
            )}
          <div
            data-zone="header"
            className={
              [
                headerSticky ? 'sticky top-0 z-40' : undefined,
                sectionVisibilityClass(layout?.header),
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          >
            <div
              aria-hidden
              className="border-b"
              style={{ minHeight: LOOK_HEADER_PX[store?.look ?? ''] ?? HEADER_MIN_PX }}
            />
          </div>
          <main role="main" className="flex-1">
            {children}
          </main>
        </div>
      </CardStepperProvider>
    );
  }

  const urlPrefix = storeUrl('');

  return (
    // ShopChrome doesn't carry its own pb anymore — the body-level
    // `pb-32 md:pb-0` in root layout.tsx covers both ShopChrome content
    // AND body siblings (cookieFallback). The previous ShopChrome pb-32
    // was redundant once body-pb landed (commit `489bdaf`) and created
    // a visible pink gap between the footer and the cookieFallback row
    // (Ahmad 2026-05-17 night: 'white space between footer and
    // underneath it'). Removed; body-pb is the single source of truth.
    <CardStepperProvider>
      <div
        className="flex min-h-screen flex-col bg-background"
        data-ui-uppercase={store?.theme?.uppercaseStyle ? 'true' : undefined}
      >
        {/* `data-zone` wrappers let the per-store typography rules in
          apps/web/src/app/layout.tsx target each storefront zone
          without having to rewrite the templates' internal markup.
          Six zones, applied uniformly across every pack. */}
        {/* Announcement bar — gated by both content presence AND page-builder
          layout.announcement.enabled (when explicitly false, hides regardless
          of content). bgColor falls back: layout.announcement.bgColor wins
          over the legacy store.announcementBar.bgColor. */}
        {(layout?.announcement?.enabled ?? store.announcementBar?.enabled) &&
          store.announcementBar?.text &&
          !store.isDemo && (
            <aside
              data-zone="beforeHeader"
              aria-label={isRtl ? 'إعلان المتجر' : 'Store announcement'}
              className={sectionVisibilityClass(layout?.announcement) ?? undefined}
            >
              <T.AnnouncementBar
                text={store.announcementBar.text}
                textAr={store.announcementBar.textAr}
                link={store.announcementBar.link}
                linkText={store.announcementBar.linkText}
                linkTextAr={store.announcementBar.linkTextAr}
                bgColor={
                  (layout?.announcement?.bgColor
                    ? resolveColor(layout.announcement.bgColor, store.theme)
                    : undefined) ?? store.announcementBar.bgColor
                }
                textColor={store.announcementBar.textColor}
                dismissible={store.announcementBar.dismissible}
                isRtl={isRtl}
                urlPrefix={storeUrl('')}
              />
            </aside>
          )}
        {/* Zone wrapper only: the skin's own header element is the one banner (a11y P2-1). */}
        <div
          data-zone="header"
          className={
            [headerSticky ? 'sticky top-0 z-40' : undefined, sectionVisibilityClass(layout?.header)]
              .filter(Boolean)
              .join(' ') || undefined
          }
        >
          <StickyHeaderOffset />
          <T.Header
            branding={branding}
            navigation={filteredNavigation}
            isRtl={isRtl}
            cartItemCount={itemCount}
            onSearch={handleSearch}
            urlPrefix={urlPrefix}
            utilityBar={utilityBar}
            headerBgColor={
              layout?.header?.bgColor
                ? (resolveColor(layout.header.bgColor, store.theme) ?? undefined)
                : undefined
            }
          />
        </div>
        <main role="main" className="flex-1">
          {children}
        </main>
        {/* Footer divider (per-section opt-in) — renders between the last
          page section and the footer. Honors `layout.footer.dividers.above`. */}
        {layout?.footer?.dividers?.above?.enabled && (
          <SectionDivider
            settings={resolveSlotDividerSettings(layout.footer.dividers, 'above')}
            // Suppress the divider's transparent padding band (which paints the
            // page bg — white on per-section-colored stores) when the footer
            // itself is colored, so it never shows as a white stripe above a
            // colored footer. Same fix as the homepage section dividers.
            hideForExplicitBg={!!layout?.footer?.bgColor}
          />
        )}
        {/* Footer wrapper carries data-zone for typography emitter targeting.
          Background override is NOT applied here — the theme's <footer>
          inside paints over it. We pass bgColor down via the FooterProps
          prop instead so the theme can replace its default bg class with
          the merchant's inline color. Ahmad 2026-05-20: footer bg save was
          not landing because of this nested-bg paint-over. */}
        <div data-zone="footer" className={sectionVisibilityClass(layout?.footer) ?? undefined}>
          <T.Footer
            branding={branding}
            contact={{
              email: contact.email,
              phone: contact.phone,
              phoneAr: contact.phoneAr,
              whatsapp: contact.whatsapp,
              address: contact.address,
              addressAr: contact.addressAr,
              addressUrl,
              addressLink,
            }}
            socials={contact.socialLinks}
            navigation={filteredNavigation}
            footerLinks={footerLinks}
            hidePoweredBy={store.enabledFeatures?.includes('remove_branding') === true}
            // Pages the merchant explicitly disabled in /content/<slug>.
            // The footer hides matching legal links so a disabled Privacy
            // page doesn't leave a dead "Privacy" link in the bottom bar.
            // The returns feature switched off counts as the returns page off: the
            // legal row's Returns link drops with it (S-01). Unknown features keep it.
            disabledCmsSlugs={footerDisabledSlugs(store.disabledCmsSlugs, store.enabledFeatures)}
            isRtl={isRtl}
            urlPrefix={urlPrefix}
            bgColor={
              layout?.footer?.bgColor
                ? (resolveColor(layout.footer.bgColor, store.theme) ?? undefined)
                : undefined
            }
            footerLogo={store.theme?.footerLogo ?? undefined}
            footerLogoInvert={store.theme?.footerLogoInvert === true}
            hideFooterLogoMobile={store.theme?.hideFooterLogoMobile === true}
            footerLogoAutoFilter={footerLogoContrastFilter(
              resolveFooterAutoContrastBg(
                store.theme,
                layout?.footer?.bgColor
                  ? (resolveColor(layout.footer.bgColor, store.theme) ?? undefined)
                  : undefined
              ),
              store.theme?.footerLogoInvert
            )}
            theme={store.theme}
            locations={store.locations}
          />
        </div>
        {/* afterFooter — empty placeholder so any merchant-injected text
          below the footer (cookie disclaimer, copyright, etc) inherits
          the typography zone. Kept zero-height when there's no content. */}
        {/* TEMPLATES-MOCK-5: the showroom's notice (e.g. "photos are illustrative") is a quiet footer line, not a
          41 px strip above every page. Only the demo store: a merchant's own announcement bar is untouched. */}
        {store.isDemo && store.announcementBar?.text && (
          <p
            data-demo-notice
            className="border-t border-border/60 px-4 py-3 text-center text-xs text-muted-foreground"
          >
            {isRtl && store.announcementBar.textAr
              ? store.announcementBar.textAr
              : store.announcementBar.text}
          </p>
        )}
        <div data-zone="afterFooter" />
        {/* Sprint 3 (2026-05-17): mobile sticky bottom tab bar. Hides
          itself on PDP / checkout / auth routes via usePathname inside
          the component. Mounts last so its fixed positioning sits above
          everything else in the chrome. Merchant color overrides from
          layout.bottomBar are threaded in (page-builder 2026-06-17). */}
        <BottomTabBar
          bottomBar={layout?.bottomBar}
          theme={store.theme}
          navigation={filteredNavigation}
        />
        {/* Ruling B4-6: a look with chrome.cartBar shows the browse cart bar on browse routes. */}
        <StickyBrowseCartBar />

        {/* Floating Widget — opt-in engagement feature 2026-05-21. Renders
          only when:
            1. `floating_widget` is in store.enabledFeatures (super-admin
               gated via the feature registry), AND
            2. `store.settings.floatingWidget.enabled` is true (merchant
               flipped it on from /stores/[id]/floating-widget).
          When either gate fails, FloatingWidget returns null. */}
        {store.enabledFeatures?.includes('floating_widget') && (
          <FloatingWidget
            config={
              (store.settings?.floatingWidget as FloatingWidgetConfig | undefined) ?? undefined
            }
            theme={store.theme}
            isRtl={isRtl}
            contact={{ whatsapp: contact.whatsapp, phone: contact.phone }}
            socials={{
              instagram: contact.socialLinks?.instagram,
              whatsapp: contact.socialLinks?.whatsapp,
              tiktok: contact.socialLinks?.tiktok,
              snapchat: contact.socialLinks?.snapchat,
              youtube: contact.socialLinks?.youtube,
              facebook: contact.socialLinks?.facebook,
              twitter: contact.socialLinks?.twitter,
              telegram: contact.socialLinks?.telegram,
            }}
          />
        )}
      </div>
    </CardStepperProvider>
  );
}

/**
 * The slugs whose footer legal link is off: the CMS pages the merchant turned
 * off, plus `returns` when the store's returns feature is switched off (its
 * request form needs the feature). Unknown features (`undefined`) keep it.
 */
export function footerDisabledSlugs(
  disabledCmsSlugs: string[] | undefined,
  enabledFeatures: string[] | undefined
): string[] | undefined {
  if (!Array.isArray(enabledFeatures) || enabledFeatures.includes('returns'))
    return disabledCmsSlugs;
  return [...(disabledCmsSlugs ?? []), 'returns'];
}
