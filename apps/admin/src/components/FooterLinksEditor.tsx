'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@force/ui';
import { apiGet, apiPut } from '../lib/api';
import { useT } from '@/i18n/useT';

/**
 * Reusable footer links + utility bar + bottom bar editor. Extracted
 * from /stores/[id]/pages 2026-05-21 (Ahmad audit: "do it then update
 * memory") so the SAME editor can be rendered:
 *   - standalone at /pages (its own AdminLayout wrapper)
 *   - embedded inside the page-builder Footer ExtraSectionCard
 *
 * The component owns its own state, load, save, and Save button. Both
 * surfaces share one source of truth.
 */

interface FooterLink {
  name: string;
  nameAr?: string;
  href: string;
  enabled: boolean;
}

interface UtilityBarLink {
  label: string;
  labelAr?: string;
  href: string;
  enabled: boolean;
}

interface UtilityBarSettings {
  enabled?: boolean;
  links?: UtilityBarLink[];
}

interface StoreSettings {
  footerLinks?: {
    shop?: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled?: boolean;
    /** @deprecated removed 2026-05-21 — storefront no longer renders.
     *  Field stays in shape so existing data on rows that pre-date the
     *  removal is preserved (just ignored by the storefront). */
    bottomBar?: unknown;
  };
  utilityBar?: UtilityBarSettings;
  [key: string]: unknown;
}

const DEFAULT_SHOP_LINKS: FooterLink[] = [
  { name: 'All Products', nameAr: 'كل المنتجات', href: '/products', enabled: true },
  { name: 'Categories', nameAr: 'الفئات', href: '/categories', enabled: true },
  { name: 'New Arrivals', nameAr: 'أحدث المنتجات', href: '/products?sort=newest', enabled: true },
  { name: 'Best Sellers', nameAr: 'الأكثر مبيعاً', href: '/products?sort=popular', enabled: true },
  { name: 'On Sale', nameAr: 'العروض', href: '/products?sale=true', enabled: true },
];

const DEFAULT_SUPPORT_LINKS: FooterLink[] = [
  { name: 'Contact Us', nameAr: 'تواصل معنا', href: '/contact', enabled: true },
  { name: 'FAQ', nameAr: 'الأسئلة الشائعة', href: '/faq', enabled: true },
  { name: 'Shipping Info', nameAr: 'معلومات الشحن', href: '/shipping', enabled: true },
  { name: 'Returns & Refunds', nameAr: 'الإرجاع والاسترداد', href: '/returns', enabled: true },
];

const DEFAULT_COMPANY_LINKS: FooterLink[] = [
  { name: 'About Us', nameAr: 'من نحن', href: '/about', enabled: true },
  { name: 'Privacy Policy', nameAr: 'سياسة الخصوصية', href: '/privacy', enabled: true },
  { name: 'Terms of Service', nameAr: 'الشروط والأحكام', href: '/terms', enabled: true },
];

const DEFAULT_UTILITY_LINKS: UtilityBarLink[] = [
  { label: 'Contact', labelAr: 'تواصل معنا', href: '/contact', enabled: true },
  { label: 'Wishlist', labelAr: 'المفضلة', href: '/wishlist', enabled: true },
];

interface FooterLinksEditorProps {
  storeId: string;
  /** When 'embedded' the editor renders without its outer help banner
   *  (the page-builder card already provides context). 'standalone'
   *  shows the full editor as it appears at /pages. */
  variant?: 'standalone' | 'embedded';
}

export function FooterLinksEditor({ storeId, variant = 'standalone' }: FooterLinksEditorProps) {
  const t = useT('pages.page');
  const { success, error: showError } = useToast();

  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [shopLinks, setShopLinks] = useState<FooterLink[]>(DEFAULT_SHOP_LINKS);
  const [supportLinks, setSupportLinks] = useState<FooterLink[]>(DEFAULT_SUPPORT_LINKS);
  const [companyLinks, setCompanyLinks] = useState<FooterLink[]>(DEFAULT_COMPANY_LINKS);
  const [newsletterEnabled, setNewsletterEnabled] = useState(true);
  const [utilityBarEnabled, setUtilityBarEnabled] = useState(true);
  const [utilityLinks, setUtilityLinks] = useState<UtilityBarLink[]>(DEFAULT_UTILITY_LINKS);

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      try {
        const { data } = await apiGet<{ store: { settings: StoreSettings } }>(
          `/api/v1/stores/${storeId}`
        );
        if (cancelled) return;
        if (data?.store) {
          const settings = (data.store.settings || {}) as StoreSettings;
          if (settings.footerLinks) {
            if (settings.footerLinks.shop?.length) setShopLinks(settings.footerLinks.shop);
            if (settings.footerLinks.support?.length) setSupportLinks(settings.footerLinks.support);
            if (settings.footerLinks.company?.length) setCompanyLinks(settings.footerLinks.company);
            if (typeof settings.footerLinks.newsletterEnabled === 'boolean') {
              setNewsletterEnabled(settings.footerLinks.newsletterEnabled);
            }
            // bottomBar field deprecated 2026-05-21 — no longer loaded/saved.
          }
          if (settings.utilityBar) {
            const ub = settings.utilityBar;
            if (typeof ub.enabled === 'boolean') setUtilityBarEnabled(ub.enabled);
            if (Array.isArray(ub.links)) {
              const cleaned = ub.links
                .filter(
                  (item): item is UtilityBarLink =>
                    !!item &&
                    typeof item === 'object' &&
                    typeof (item as { label?: unknown }).label === 'string' &&
                    typeof (item as { href?: unknown }).href === 'string'
                )
                .map(item => ({
                  label: item.label,
                  labelAr: typeof item.labelAr === 'string' ? item.labelAr : undefined,
                  href: item.href,
                  enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
                }));
              if (cleaned.length) setUtilityLinks(cleaned);
            }
          }
        }
      } catch {
        // use defaults
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadSettings();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const { data: getData } = await apiGet<{ store: { settings: StoreSettings } }>(
        `/api/v1/stores/${storeId}`
      );
      const currentSettings = (getData?.store?.settings || {}) as StoreSettings;
      const newSettings = {
        ...currentSettings,
        footerLinks: {
          shop: shopLinks,
          support: supportLinks,
          company: companyLinks,
          newsletterEnabled,
          // bottomBar removed 2026-05-21 — redundant with Company Links.
          // Existing rows keep their stale field; new saves omit it.
        },
        utilityBar: {
          enabled: utilityBarEnabled,
          links: utilityLinks
            .filter(link => link.label.trim() && link.href.trim())
            .map(link => ({
              label: link.label.trim(),
              labelAr: link.labelAr?.trim() || undefined,
              href: link.href.trim(),
              enabled: link.enabled,
            })),
        },
      };
      const { error: saveError } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: newSettings,
      });
      if (!saveError) {
        success(t('toastSavedTitle'), t('toastSavedBody'));
      } else {
        showError(t('toastErrorTitle'), saveError.message || t('toastFailedSave'));
      }
    } catch {
      showError(t('toastErrorTitle'), t('toastFailedSaveLinks'));
    } finally {
      setIsSaving(false);
    }
  }

  function getSetter(section: 'shop' | 'support' | 'company') {
    if (section === 'shop') return setShopLinks;
    if (section === 'support') return setSupportLinks;
    return setCompanyLinks;
  }
  function updateLink(
    section: 'shop' | 'support' | 'company',
    index: number,
    field: keyof FooterLink,
    value: string | boolean
  ) {
    getSetter(section)(prev =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link))
    );
  }
  function addLink(section: 'shop' | 'support' | 'company') {
    getSetter(section)(prev => [...prev, { name: '', href: '/', enabled: true }]);
  }
  function removeLink(section: 'shop' | 'support' | 'company', index: number) {
    getSetter(section)(prev => prev.filter((_, i) => i !== index));
  }
  function updateUtilityLink(index: number, field: keyof UtilityBarLink, value: string | boolean) {
    setUtilityLinks(prev =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link))
    );
  }
  function addUtilityLink() {
    setUtilityLinks(prev => [...prev, { label: '', href: '/', enabled: true }]);
  }
  function removeUtilityLink(index: number) {
    setUtilityLinks(prev => prev.filter((_, i) => i !== index));
  }

  function renderLinkEditor(
    title: string,
    section: 'shop' | 'support' | 'company',
    links: FooterLink[]
  ) {
    return (
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={() => addLink(section)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('addLink')}
          </button>
        </div>
        {links.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">{t('emptyLinks')}</p>
        ) : (
          <div className="space-y-3">
            {links.map((link, index) => (
              <div key={index} className="flex items-center gap-3 rounded-lg border p-3">
                <input
                  type="checkbox"
                  checked={link.enabled}
                  onChange={e => updateLink(section, index, 'enabled', e.target.checked)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                <input
                  type="text"
                  value={link.name}
                  onChange={e => updateLink(section, index, 'name', e.target.value)}
                  placeholder={t('linkNamePlaceholder')}
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  value={link.nameAr || ''}
                  onChange={e => updateLink(section, index, 'nameAr', e.target.value)}
                  placeholder={t('linkNameArPlaceholder')}
                  lang="ar"
                  dir="rtl"
                  className="w-40 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  value={link.href}
                  onChange={e => updateLink(section, index, 'href', e.target.value)}
                  placeholder={t('linkPathPlaceholder')}
                  className="w-40 rounded-lg border border-border px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => removeLink(section, index)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/5 hover:text-destructive transition-colors"
                  title={t('removeLink')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {variant === 'standalone' && (
        <div className="rounded-xl border border-info/30 bg-info/5 p-4">
          <p className="text-sm text-info">
            {t('help')} <code className="bg-info/10 px-1 rounded">{t('helpCode')}</code>
            {t('helpClose')}
          </p>
        </div>
      )}

      {/* Utility bar (pre-header) */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('utilityBar')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('utilityBarHint')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={utilityBarEnabled}
              onChange={e => setUtilityBarEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
          </label>
        </div>
        {utilityBarEnabled && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('utilityBarLinks')}
              </p>
              <button
                type="button"
                onClick={addUtilityLink}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t('addLink')}
              </button>
            </div>
            {utilityLinks.length === 0 ? (
              <p className="text-muted-foreground text-sm py-4 text-center">{t('emptyLinks')}</p>
            ) : (
              <div className="space-y-3">
                {utilityLinks.map((link, index) => (
                  <div key={index} className="flex items-center gap-3 rounded-lg border p-3">
                    <input
                      type="checkbox"
                      checked={link.enabled}
                      onChange={e => updateUtilityLink(index, 'enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <input
                      type="text"
                      value={link.label}
                      onChange={e => updateUtilityLink(index, 'label', e.target.value)}
                      placeholder={t('utilityBarLabelPlaceholder')}
                      className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                      type="text"
                      value={link.labelAr || ''}
                      onChange={e => updateUtilityLink(index, 'labelAr', e.target.value)}
                      placeholder={t('utilityBarLabelArPlaceholder')}
                      lang="ar"
                      dir="rtl"
                      className="w-40 rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                      type="text"
                      value={link.href}
                      onChange={e => updateUtilityLink(index, 'href', e.target.value)}
                      placeholder={t('linkPathPlaceholder')}
                      className="w-40 rounded-lg border border-border px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                      type="button"
                      onClick={() => removeUtilityLink(index)}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/5 hover:text-destructive transition-colors"
                      title={t('removeLink')}
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {renderLinkEditor(t('shopLinks'), 'shop', shopLinks)}
      {renderLinkEditor(t('supportLinks'), 'support', supportLinks)}
      {renderLinkEditor(t('companyLinks'), 'company', companyLinks)}

      {/* Newsletter */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('newsletter')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('newsletterHint')}</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={newsletterEnabled}
              onChange={e => setNewsletterEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
          </label>
        </div>
      </div>

      {/* Bottom bar section removed 2026-05-21 — was redundant with the
          Company Links section above. Merchants put Privacy / Terms /
          Shipping into Company Links if they want them in the footer. */}

      {/* Save button. Embedded variant in page-builder shows this too —
          editor is fully self-contained, no coupling to outer Save flows. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isSaving && (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {isSaving ? t('saving') : t('saveChanges')}
        </button>
      </div>
    </div>
  );
}
