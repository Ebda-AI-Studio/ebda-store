'use client';

import { useRouter } from 'next/navigation';
import { useStore, useStoreBranding, useStoreContact, useStoreUrl } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import type { FooterLinkSection, FooterLinksConfig, NavItem } from '../templates/types';
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
          return {
            shop: normalizeSection(src.shop),
            company: normalizeSection(src.company),
            support: normalizeSection(src.support),
            newsletterEnabled: newsletter,
          };
        })()
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
    <div className="flex min-h-screen flex-col bg-background">
      {store.announcementBar?.enabled && store.announcementBar.text && (
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
      )}
      <T.Header
        branding={branding}
        navigation={navigation}
        isRtl={isRtl}
        cartItemCount={itemCount}
        onSearch={handleSearch}
        urlPrefix={urlPrefix}
      />
      <main className="flex-1">{children}</main>
      <T.Footer
        branding={branding}
        contact={{
          email: contact.email,
          phone: contact.phone,
          phoneAr: contact.phoneAr,
          whatsapp: contact.whatsapp,
          address: contact.address,
          addressAr: contact.addressAr,
        }}
        socials={contact.socialLinks}
        navigation={navigation}
        footerLinks={footerLinks}
        isRtl={isRtl}
        urlPrefix={urlPrefix}
      />
    </div>
  );
}
