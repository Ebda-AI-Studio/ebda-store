'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

interface FooterLink {
  name: string;
  nameAr?: string;
  href: string;
  enabled: boolean;
}

/**
 * Bottom-bar config persisted at `store.settings.footerLinks.bottomBar`.
 * `enabled` hides the whole copyright row when false; `copyrightOverride`
 * (and the Arabic variant) replaces the default
 * `© YEAR <store name>. All rights reserved.` string. Per-link booleans
 * default to true so stores that haven't visited this section keep seeing
 * the legacy Privacy + Terms links.
 */
interface BottomBarSettings {
  enabled?: boolean;
  copyrightOverride?: string;
  copyrightOverrideAr?: string;
  privacyEnabled?: boolean;
  termsEnabled?: boolean;
  shippingEnabled?: boolean;
}

interface StoreSettings {
  footerLinks?: {
    shop?: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled?: boolean;
    bottomBar?: BottomBarSettings;
  };
  [key: string]: unknown;
}

const DEFAULT_BOTTOM_BAR: Required<
  Pick<BottomBarSettings, 'enabled' | 'privacyEnabled' | 'termsEnabled' | 'shippingEnabled'>
> &
  Pick<BottomBarSettings, 'copyrightOverride' | 'copyrightOverrideAr'> = {
  enabled: true,
  privacyEnabled: true,
  termsEnabled: true,
  shippingEnabled: true,
  copyrightOverride: '',
  copyrightOverrideAr: '',
};

const DEFAULT_SHOP_LINKS: FooterLink[] = [
  { name: 'All Products', nameAr: 'كل المنتجات', href: '/products', enabled: true },
  { name: 'Categories', nameAr: 'الفئات', href: '/categories', enabled: true },
  { name: 'New Arrivals', nameAr: 'أحدث المنتجات', href: '/products?sort=newest', enabled: true },
  {
    name: 'Best Sellers',
    nameAr: 'الأكثر مبيعاً',
    href: '/products?sort=popular',
    enabled: true,
  },
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

export default function StorePagesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('pages.page');
  const { success, error: showError } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [shopLinks, setShopLinks] = useState<FooterLink[]>(DEFAULT_SHOP_LINKS);
  const [supportLinks, setSupportLinks] = useState<FooterLink[]>(DEFAULT_SUPPORT_LINKS);
  const [companyLinks, setCompanyLinks] = useState<FooterLink[]>(DEFAULT_COMPANY_LINKS);
  const [newsletterEnabled, setNewsletterEnabled] = useState(true);
  const [bottomBar, setBottomBar] = useState<typeof DEFAULT_BOTTOM_BAR>(DEFAULT_BOTTOM_BAR);

  // loadSettings was previously a sibling function referenced in the effect
  // below; inlining it here keeps the dependency list honest (only storeId)
  // and uses a cancellation flag to avoid setting state after unmount.
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
            if (settings.footerLinks.shop?.length) {
              setShopLinks(settings.footerLinks.shop);
            }
            if (settings.footerLinks.support?.length) {
              setSupportLinks(settings.footerLinks.support);
            }
            if (settings.footerLinks.company?.length) {
              setCompanyLinks(settings.footerLinks.company);
            }
            if (typeof settings.footerLinks.newsletterEnabled === 'boolean') {
              setNewsletterEnabled(settings.footerLinks.newsletterEnabled);
            }
            if (settings.footerLinks.bottomBar) {
              const bb = settings.footerLinks.bottomBar;
              setBottomBar(prev => ({
                enabled: typeof bb.enabled === 'boolean' ? bb.enabled : prev.enabled,
                privacyEnabled:
                  typeof bb.privacyEnabled === 'boolean' ? bb.privacyEnabled : prev.privacyEnabled,
                termsEnabled:
                  typeof bb.termsEnabled === 'boolean' ? bb.termsEnabled : prev.termsEnabled,
                shippingEnabled:
                  typeof bb.shippingEnabled === 'boolean'
                    ? bb.shippingEnabled
                    : prev.shippingEnabled,
                copyrightOverride:
                  typeof bb.copyrightOverride === 'string' ? bb.copyrightOverride : '',
                copyrightOverrideAr:
                  typeof bb.copyrightOverrideAr === 'string' ? bb.copyrightOverrideAr : '',
              }));
            }
          }
        }
      } catch {
        // Use defaults
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
      // First fetch current settings to merge
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
          // Persist the bottom bar config — copyright override fields are
          // trimmed so an accidental whitespace string doesn't beat the
          // computed default at render time.
          bottomBar: {
            enabled: bottomBar.enabled,
            privacyEnabled: bottomBar.privacyEnabled,
            termsEnabled: bottomBar.termsEnabled,
            shippingEnabled: bottomBar.shippingEnabled,
            copyrightOverride: (bottomBar.copyrightOverride || '').trim() || undefined,
            copyrightOverrideAr: (bottomBar.copyrightOverrideAr || '').trim() || undefined,
          },
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
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={link.enabled}
                    onChange={e => updateLink(section, index, 'enabled', e.target.checked)}
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                </label>
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
      <AdminLayout title={t('title')} subtitle={t('loadingSubtitle')}>
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex gap-3">
          <Link href={`/stores/${storeId}/settings`}>
            <Button type="button" variant="outline">
              {t('backToSettings')}
            </Button>
          </Link>
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
      }
    >
      <div className="space-y-6">
        <div className="rounded-xl border border-info/30 bg-info/5 p-4">
          <p className="text-sm text-info">
            {t('help')} <code className="bg-info/10 px-1 rounded">{t('helpCode')}</code>
            {t('helpClose')}
          </p>
        </div>

        {renderLinkEditor(t('shopLinks'), 'shop', shopLinks)}
        {renderLinkEditor(t('supportLinks'), 'support', supportLinks)}
        {renderLinkEditor(t('companyLinks'), 'company', companyLinks)}

        {/* Newsletter Toggle */}
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

        {/* Bottom bar — controls the copyright row at the bottom of every
            footer pack. Each toggle is independent so a store can hide e.g.
            the shipping link without affecting privacy / terms. The copyright
            override fields beat the default `© YEAR <store>. All rights
            reserved.` string when non-empty. */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('bottomBar')}</h2>
              <p className="text-sm text-muted-foreground mt-1">{t('bottomBarHint')}</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={bottomBar.enabled}
                onChange={e => setBottomBar(prev => ({ ...prev, enabled: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
            </label>
          </div>

          {bottomBar.enabled && (
            <div className="space-y-4">
              {/* Copyright override — empty falls back to the computed default. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {t('copyrightOverride')}
                  </label>
                  <input
                    type="text"
                    value={bottomBar.copyrightOverride || ''}
                    onChange={e =>
                      setBottomBar(prev => ({ ...prev, copyrightOverride: e.target.value }))
                    }
                    placeholder={t('copyrightOverridePlaceholder')}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1.5">
                    {t('copyrightOverrideAr')}
                  </label>
                  <input
                    type="text"
                    value={bottomBar.copyrightOverrideAr || ''}
                    onChange={e =>
                      setBottomBar(prev => ({ ...prev, copyrightOverrideAr: e.target.value }))
                    }
                    placeholder={t('copyrightOverrideArPlaceholder')}
                    lang="ar"
                    dir="rtl"
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              {/* Per-link toggles. */}
              <div className="space-y-2 pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {t('legalLinks')}
                </p>
                {(
                  [
                    ['privacyEnabled', 'privacyToggle'],
                    ['termsEnabled', 'termsToggle'],
                    ['shippingEnabled', 'shippingToggle'],
                  ] as const
                ).map(([field, labelKey]) => (
                  <label
                    key={field}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <span className="text-sm text-foreground">{t(labelKey)}</span>
                    <input
                      type="checkbox"
                      checked={bottomBar[field]}
                      onChange={e => setBottomBar(prev => ({ ...prev, [field]: e.target.checked }))}
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
