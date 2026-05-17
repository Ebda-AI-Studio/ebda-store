'use client';

import { useRouter } from 'next/navigation';
import { useStore, useStoreBranding, useStoreContact, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { BottomTabBar } from '../templates/shared/BottomTabBar';
import type {
  FooterBottomBarConfig,
  FooterLinkSection,
  FooterLinksConfig,
  NavItem,
  ResolvedUtilityBar,
} from '../templates/types';
import { ReactNode } from 'react';

/**
 * The full storefront chrome: template-selected Header + AnnouncementBar +
 * children + Footer. Wrap a page's content in this to get the selected
 * template's look across the whole surface. Only /auth, /checkout, and the
 * public wishlist-share page use MinimalChrome instead.
 */
export function ShopChrome({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { store } = useStore();
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
    // pb-20 on mobile reserves 80px at the very bottom of the document so
    // the fixed BottomTabBar (56px + safe-area-inset) doesn't cover the
    // footer's last rows (Powered by Force AI credit + cookie preferences
    // link + payment icons). Lives on the OUTER container — previous fix
    // on <main> alone wasn't enough because footer + afterFooter sit
    // OUTSIDE main, so they still got clipped. Desktop has no tab bar.
    <div className="flex min-h-screen flex-col bg-background pb-20 md:pb-0">
      {/* `data-zone` wrappers let the per-store typography rules in
          apps/web/src/app/layout.tsx target each storefront zone
          without having to rewrite the templates' internal markup.
          Six zones, applied uniformly across all 5 packs. */}
      {store.announcementBar?.enabled && store.announcementBar.text && (
        <div data-zone="beforeHeader">
          <T.AnnouncementBar
            text={store.announcementBar.text}
            textAr={store.announcementBar.textAr}
            link={store.announcementBar.link}
            linkText={store.announcementBar.linkText}
            linkTextAr={store.announcementBar.linkTextAr}
            bgColor={store.announcementBar.bgColor}
            textColor={store.announcementBar.textColor}
            dismissible={store.announcementBar.dismissible}
            isRtl={isRtl}
          />
        </div>
      )}
      <header role="banner" data-zone="header">
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
      <footer role="contentinfo" data-zone="footer">
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
        />
      </footer>
      {/* afterFooter — empty placeholder so any merchant-injected text
          below the footer (cookie disclaimer, copyright, etc) inherits
          the typography zone. Kept zero-height when there's no content. */}
      <div data-zone="afterFooter" />
      {/* Sprint 3 (2026-05-17): mobile sticky bottom tab bar. Hides
          itself on PDP / checkout / auth routes via usePathname inside
          the component. Mounts last so its fixed positioning sits above
          everything else in the chrome. */}
      <BottomTabBar />
    </div>
  );
}
