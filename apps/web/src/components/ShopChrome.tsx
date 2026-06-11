'use client';

import { useRouter } from 'next/navigation';
import { useStore, useStoreBranding, useStoreContact, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { BottomTabBar } from '../templates/shared/BottomTabBar';
import { FloatingWidget } from '../templates/shared/FloatingWidget';
import { SectionDivider, resolveSlotDividerSettings } from '../templates/shared/SectionDivider';
import type { FloatingWidgetConfig } from '@force/shared';
import { resolveColor, footerLogoContrastFilter, resolveBackgroundPreset } from '@force/shared';
import type { StoreLayoutSettings } from '@force/shared';
import type {
  FooterBottomBarConfig,
  FooterLinkSection,
  FooterLinksConfig,
  NavItem,
  ResolvedUtilityBar,
} from '../templates/types';
import { ReactNode } from 'react';

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
  const { store, layout: ctxLayout } = useStore();
  // Prop wins (homepage server-fetches layout for SSR correctness); context
  // layout is the lazy-fetched fallback for other routes.
  const layout = layoutProp ?? ctxLayout ?? undefined;
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
  const defaultNav: NavItem[] = [
    { label: 'Products', labelAr: 'المنتجات', href: storeUrl('/products') },
    { label: 'Categories', labelAr: 'الفئات', href: storeUrl('/categories') },
    { label: 'About', labelAr: 'من نحن', href: storeUrl('/about') },
    { label: 'Contact', labelAr: 'تواصل معنا', href: storeUrl('/contact') },
  ];
  const customNav = store.settings?.navMenu;
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
          href: item.href.startsWith('http') ? item.href : storeUrl(item.href),
        }))
    : defaultNav;

  // Per-store footer columns are saved in `store.settings.footerLinks` by the
  // admin's pages settings UI. Mirror the navMenu treatment: only forward if
  // the saved value is a plain object, drop malformed sections, and rewrite
  // relative hrefs through storeUrl() so multi-tenant platform URLs get the
  // correct slug prefix. Each template handles a missing/empty config by
  // falling back to its built-in default layout.
  const rawFooterLinks = store.settings?.footerLinks;
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
                href: item.href.startsWith('http') ? item.href : storeUrl(item.href),
                enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
              }));
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
  const rawUtilityBar = store.settings?.utilityBar;
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
                  href: item.href.startsWith('http') ? item.href : storeUrl(item.href),
                  enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
                }))
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
    router.push(storeUrl(`/search?q=${encodeURIComponent(query)}`));
  };

  if (templateLoading || !T) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        {/* Reserve chrome height so the page doesn't jump on hydration. */}
        <div className="h-16 border-b" aria-hidden />
        <main className="flex-1">{children}</main>
      </div>
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
    <div className="flex min-h-screen flex-col bg-background">
      {/* `data-zone` wrappers let the per-store typography rules in
          apps/web/src/app/layout.tsx target each storefront zone
          without having to rewrite the templates' internal markup.
          Six zones, applied uniformly across all 5 packs. */}
      {/* Announcement bar — gated by both content presence AND page-builder
          layout.announcement.enabled (when explicitly false, hides regardless
          of content). bgColor falls back: layout.announcement.bgColor wins
          over the legacy store.announcementBar.bgColor. */}
      {(layout?.announcement?.enabled ?? store.announcementBar?.enabled) &&
        store.announcementBar?.text && (
          <div data-zone="beforeHeader">
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
            />
          </div>
        )}
      <header
        role="banner"
        data-zone="header"
        className={layout?.header?.sticky ? 'sticky top-0 z-40' : undefined}
        style={
          layout?.header?.bgColor
            ? { backgroundColor: resolveColor(layout.header.bgColor, store.theme) ?? undefined }
            : undefined
        }
      >
        <T.Header
          branding={branding}
          navigation={navigation}
          isRtl={isRtl}
          cartItemCount={itemCount}
          onSearch={handleSearch}
          urlPrefix={urlPrefix}
          utilityBar={utilityBar}
        />
      </header>
      <main role="main" className="flex-1">
        {children}
      </main>
      {/* Footer divider (per-section opt-in) — renders between the last
          page section and the footer. Honors `layout.footer.dividers.above`. */}
      {layout?.footer?.dividers?.above?.enabled && (
        <SectionDivider settings={resolveSlotDividerSettings(layout.footer.dividers, 'above')} />
      )}
      {/* Footer wrapper carries data-zone for typography emitter targeting.
          Background override is NOT applied here — the theme's <footer>
          inside paints over it. We pass bgColor down via the FooterProps
          prop instead so the theme can replace its default bg class with
          the merchant's inline color. Ahmad 2026-05-20: footer bg save was
          not landing because of this nested-bg paint-over. */}
      <div data-zone="footer">
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
          navigation={navigation}
          footerLinks={footerLinks}
          // Pages the merchant explicitly disabled in /content/<slug>.
          // The footer hides matching legal links so a disabled Privacy
          // page doesn't leave a dead "Privacy" link in the bottom bar.
          disabledCmsSlugs={store.disabledCmsSlugs}
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
          footerLogoAutoFilter={(() => {
            // Resolve the EFFECTIVE footer background so the brand-logo fallback
            // is auto-contrasted against whatever color the footer actually paints.
            // Priority: merchant's explicit page-builder override (resolved hex) →
            // theme default (the section-alt HSL triplet from resolveBackgroundPreset).
            // Both formats are parseable by pickReadableForeground in @force/shared.
            const explicitBg = layout?.footer?.bgColor
              ? (resolveColor(layout.footer.bgColor, store.theme) ?? undefined)
              : undefined;
            const themeBg =
              explicitBg ?? `hsl(${resolveBackgroundPreset(store.theme).bgSectionAlt})`;
            return footerLogoContrastFilter(themeBg, store.theme?.footerLogoInvert);
          })()}
        />
      </div>
      {/* afterFooter — empty placeholder so any merchant-injected text
          below the footer (cookie disclaimer, copyright, etc) inherits
          the typography zone. Kept zero-height when there's no content. */}
      <div data-zone="afterFooter" />
      {/* Sprint 3 (2026-05-17): mobile sticky bottom tab bar. Hides
          itself on PDP / checkout / auth routes via usePathname inside
          the component. Mounts last so its fixed positioning sits above
          everything else in the chrome. */}
      <BottomTabBar />

      {/* Floating Widget — opt-in engagement feature 2026-05-21. Renders
          only when:
            1. `floating_widget` is in store.enabledFeatures (super-admin
               gated via the feature registry), AND
            2. `store.settings.floatingWidget.enabled` is true (merchant
               flipped it on from /stores/[id]/floating-widget).
          When either gate fails, FloatingWidget returns null. */}
      {store.enabledFeatures?.includes('floating_widget') && (
        <FloatingWidget
          config={(store.settings?.floatingWidget as FloatingWidgetConfig | undefined) ?? undefined}
          theme={store.theme}
          isRtl={isRtl}
          contact={{ whatsapp: contact.whatsapp, phone: contact.phone }}
          socials={{
            instagram: contact.socialLinks?.instagram,
            whatsapp: contact.socialLinks?.whatsapp,
          }}
        />
      )}
    </div>
  );
}
