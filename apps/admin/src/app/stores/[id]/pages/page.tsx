'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useToast } from '@force/ui';
import { apiGet, apiPut } from '../../../../lib/api';

interface FooterLink {
  name: string;
  nameAr?: string;
  href: string;
  enabled: boolean;
}

interface StoreSettings {
  footerLinks?: {
    shop?: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled?: boolean;
  };
  [key: string]: unknown;
}

const DEFAULT_SHOP_LINKS: FooterLink[] = [
  { name: 'All Products', href: '/products', enabled: true },
  { name: 'Categories', href: '/categories', enabled: true },
  { name: 'New Arrivals', href: '/products?sort=newest', enabled: true },
  { name: 'Best Sellers', href: '/products?sort=popular', enabled: true },
  { name: 'On Sale', href: '/products?sale=true', enabled: true },
];

const DEFAULT_SUPPORT_LINKS: FooterLink[] = [
  { name: 'Contact Us', href: '/contact', enabled: true },
  { name: 'FAQ', href: '/faq', enabled: true },
  { name: 'Shipping Info', href: '/shipping', enabled: true },
  { name: 'Returns & Refunds', href: '/returns', enabled: true },
];

const DEFAULT_COMPANY_LINKS: FooterLink[] = [
  { name: 'About Us', href: '/about', enabled: true },
  { name: 'Privacy Policy', href: '/privacy', enabled: true },
  { name: 'Terms of Service', href: '/terms', enabled: true },
];

export default function StorePagesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success, error: showError } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [shopLinks, setShopLinks] = useState<FooterLink[]>(DEFAULT_SHOP_LINKS);
  const [supportLinks, setSupportLinks] = useState<FooterLink[]>(DEFAULT_SUPPORT_LINKS);
  const [companyLinks, setCompanyLinks] = useState<FooterLink[]>(DEFAULT_COMPANY_LINKS);
  const [newsletterEnabled, setNewsletterEnabled] = useState(true);

  useEffect(() => {
    loadSettings();
  }, [storeId]);

  async function loadSettings() {
    try {
      const { data } = await apiGet<{ store: { settings: StoreSettings } }>(
        `/api/v1/stores/${storeId}`
      );
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
        }
      }
    } catch {
      // Use defaults
    } finally {
      setIsLoading(false);
    }
  }

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
        },
      };

      const { error: saveError } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: newSettings,
      });
      if (!saveError) {
        success('Saved', 'Footer links updated successfully.');
      } else {
        showError('Error', saveError.message || 'Failed to save.');
      }
    } catch {
      showError('Error', 'Failed to save footer links.');
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
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
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
            Add Link
          </button>
        </div>

        {links.length === 0 ? (
          <p className="text-gray-500 text-sm py-4 text-center">
            No links configured. Click &quot;Add Link&quot; to add one.
          </p>
        ) : (
          <div className="space-y-3">
            {links.map((link, index) => (
              <div key={index} className="flex items-center gap-3 rounded-lg border p-3">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={link.enabled}
                    onChange={e => updateLink(section, index, 'enabled', e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                </label>
                <input
                  type="text"
                  value={link.name}
                  onChange={e => updateLink(section, index, 'name', e.target.value)}
                  placeholder="Link name"
                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  value={link.nameAr || ''}
                  onChange={e => updateLink(section, index, 'nameAr', e.target.value)}
                  placeholder="Arabic name (optional)"
                  dir="rtl"
                  className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="text"
                  value={link.href}
                  onChange={e => updateLink(section, index, 'href', e.target.value)}
                  placeholder="/page-path"
                  className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={() => removeLink(section, index)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                  title="Remove link"
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
      <AdminLayout title="Footer & Pages" subtitle="Manage footer links and store pages">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Footer & Pages"
      subtitle="Manage the links shown in your store's footer"
      actions={
        <div className="flex gap-3">
          <Link href={`/stores/${storeId}/settings`}>
            <button className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 font-medium">
              Back to Settings
            </button>
          </Link>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isSaving && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm text-blue-800">
            Configure which links appear in your store&apos;s footer. Disable links to hide them, or
            add new ones. Links use relative paths (e.g.,{' '}
            <code className="bg-blue-100 px-1 rounded">/faq</code>).
          </p>
        </div>

        {renderLinkEditor('Shop Links', 'shop', shopLinks)}
        {renderLinkEditor('Support Links', 'support', supportLinks)}
        {renderLinkEditor('Company Links', 'company', companyLinks)}

        {/* Newsletter Toggle */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Newsletter Section</h2>
              <p className="text-sm text-gray-500 mt-1">
                Show or hide the newsletter signup form in the footer.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={newsletterEnabled}
                onChange={e => setNewsletterEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
            </label>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
