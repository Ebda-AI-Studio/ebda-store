'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';

interface StoreTheme {
  primaryColor: string;
  primaryForeground: string;
  secondaryColor: string;
  backgroundColor: string;
  foregroundColor: string;
  fontFamily: string;
  borderRadius: string;
}

interface StoreBranding {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  theme: StoreTheme;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  socialLinks: {
    instagram?: string;
    facebook?: string;
    twitter?: string;
    tiktok?: string;
    youtube?: string;
    snapchat?: string;
  };
}

const defaultTheme: StoreTheme = {
  primaryColor: '26 100% 50%',
  primaryForeground: '0 0% 100%',
  secondaryColor: '220 14% 96%',
  backgroundColor: '0 0% 100%',
  foregroundColor: '224 71% 4%',
  fontFamily: 'default',
  borderRadius: 'md',
};

const fontOptions = [
  { value: 'default', label: 'Default (Sans-serif)', labelAr: 'الافتراضي' },
  { value: 'serif', label: 'Serif (Elegant)', labelAr: 'سيريف (أنيق)' },
  { value: 'modern', label: 'Modern (Geometric)', labelAr: 'عصري (هندسي)' },
  { value: 'rounded', label: 'Rounded (Friendly)', labelAr: 'مستدير (ودود)' },
];

const borderRadiusOptions = [
  { value: 'none', label: 'None (Sharp)', labelAr: 'بدون (حاد)' },
  { value: 'sm', label: 'Small', labelAr: 'صغير' },
  { value: 'md', label: 'Medium', labelAr: 'متوسط' },
  { value: 'lg', label: 'Large', labelAr: 'كبير' },
  { value: 'xl', label: 'Extra Large', labelAr: 'كبير جداً' },
];

const colorPresets = [
  { name: 'Orange', color: '26 100% 50%' },
  { name: 'Blue', color: '221 83% 53%' },
  { name: 'Green', color: '142 76% 36%' },
  { name: 'Purple', color: '262 83% 58%' },
  { name: 'Rose', color: '340 82% 52%' },
  { name: 'Teal', color: '173 80% 40%' },
  { name: 'Amber', color: '38 92% 50%' },
  { name: 'Black', color: '0 0% 9%' },
];

export default function StoreBrandingPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [branding, setBranding] = useState<StoreBranding | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'branding' | 'theme' | 'contact' | 'social'>('branding');

  useEffect(() => {
    fetchBranding();
  }, [storeId]);

  async function fetchBranding() {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores/${storeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (data.success && data.data?.store) {
        const store = data.data.store;
        setBranding({
          id: store.id,
          name: store.name,
          nameAr: store.nameAr,
          logo: store.logo,
          logoAr: store.logoAr,
          favicon: store.favicon,
          description: store.description,
          descriptionAr: store.descriptionAr,
          theme: { ...defaultTheme, ...(store.theme || {}) },
          email: store.email,
          phone: store.phone,
          phoneAr: store.phoneAr,
          whatsapp: store.whatsapp,
          address: store.address,
          addressAr: store.addressAr,
          socialLinks: store.socialLinks || {},
        });
      }
    } catch (error) {
      console.error('Failed to fetch branding:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    if (!branding) return;

    setIsSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores/${storeId}/branding`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: branding.name,
          nameAr: branding.nameAr,
          logo: branding.logo,
          logoAr: branding.logoAr,
          favicon: branding.favicon,
          description: branding.description,
          descriptionAr: branding.descriptionAr,
          theme: branding.theme,
          email: branding.email,
          phone: branding.phone,
          phoneAr: branding.phoneAr,
          whatsapp: branding.whatsapp,
          address: branding.address,
          addressAr: branding.addressAr,
          socialLinks: branding.socialLinks,
        }),
      });

      if (response.ok) {
        alert('Branding saved successfully!');
      }
    } catch (error) {
      console.error('Failed to save branding:', error);
      alert('Failed to save branding');
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!branding) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Store not found</p>
        <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
          Back to stores
        </Link>
      </div>
    );
  }

  return (
    <AdminLayout
      title="Store Branding"
      subtitle={`Customize ${branding.name}'s visual identity`}
      actions={
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      }
    >
      <div className="space-y-6">

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200">
        {[
          { id: 'branding', label: 'Branding' },
          { id: 'theme', label: 'Theme & Colors' },
          { id: 'contact', label: 'Contact Info' },
          { id: 'social', label: 'Social Links' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Branding Tab */}
      {activeTab === 'branding' && (
        <div className="bg-white rounded-xl border p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Store Name</label>
              <input
                type="text"
                value={branding.name}
                onChange={(e) => setBranding({ ...branding, name: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Store Name (Arabic)</label>
              <input
                type="text"
                dir="rtl"
                value={branding.nameAr || ''}
                onChange={(e) => setBranding({ ...branding, nameAr: e.target.value })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL</label>
              <input
                type="url"
                value={branding.logo || ''}
                onChange={(e) => setBranding({ ...branding, logo: e.target.value })}
                placeholder="https://example.com/logo.png"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
              {branding.logo && (
                <div className="mt-2 p-4 bg-gray-50 rounded-lg">
                  <img src={branding.logo} alt="Logo preview" className="h-12 object-contain" />
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Logo URL (Arabic)</label>
              <input
                type="url"
                value={branding.logoAr || ''}
                onChange={(e) => setBranding({ ...branding, logoAr: e.target.value })}
                placeholder="https://example.com/logo-ar.png"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Favicon URL</label>
            <input
              type="url"
              value={branding.favicon || ''}
              onChange={(e) => setBranding({ ...branding, favicon: e.target.value })}
              placeholder="https://example.com/favicon.ico"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={branding.description || ''}
                onChange={(e) => setBranding({ ...branding, description: e.target.value })}
                rows={3}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description (Arabic)</label>
              <textarea
                dir="rtl"
                value={branding.descriptionAr || ''}
                onChange={(e) => setBranding({ ...branding, descriptionAr: e.target.value })}
                rows={3}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Theme Tab */}
      {activeTab === 'theme' && (
        <div className="bg-white rounded-xl border p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">Primary Color</label>
            <div className="flex flex-wrap gap-3">
              {colorPresets.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => setBranding({
                    ...branding,
                    theme: { ...branding.theme, primaryColor: preset.color },
                  })}
                  className={`w-10 h-10 rounded-full border-2 transition-all ${
                    branding.theme.primaryColor === preset.color
                      ? 'border-gray-900 scale-110'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: `hsl(${preset.color})` }}
                  title={preset.name}
                />
              ))}
            </div>
            <div className="mt-3">
              <input
                type="text"
                value={branding.theme.primaryColor}
                onChange={(e) => setBranding({
                  ...branding,
                  theme: { ...branding.theme, primaryColor: e.target.value },
                })}
                placeholder="HSL value (e.g., 26 100% 50%)"
                className="w-full max-w-xs px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Font Family</label>
              <select
                value={branding.theme.fontFamily}
                onChange={(e) => setBranding({
                  ...branding,
                  theme: { ...branding.theme, fontFamily: e.target.value },
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                {fontOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius</label>
              <select
                value={branding.theme.borderRadius}
                onChange={(e) => setBranding({
                  ...branding,
                  theme: { ...branding.theme, borderRadius: e.target.value },
                })}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                {borderRadiusOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Preview */}
          <div className="mt-8 pt-6 border-t">
            <h3 className="text-sm font-medium text-gray-700 mb-4">Preview</h3>
            <div className="p-6 bg-gray-50 rounded-xl" style={{ '--primary': branding.theme.primaryColor } as React.CSSProperties}>
              <div className="flex items-center gap-4 mb-4">
                <button
                  className="px-4 py-2 text-white rounded-lg"
                  style={{ backgroundColor: `hsl(${branding.theme.primaryColor})` }}
                >
                  Primary Button
                </button>
                <button className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">
                  Secondary Button
                </button>
              </div>
              <p style={{ color: `hsl(${branding.theme.primaryColor})` }}>
                This is how your primary color looks as text.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Contact Tab */}
      {activeTab === 'contact' && (
        <div className="bg-white rounded-xl border p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={branding.email || ''}
                onChange={(e) => setBranding({ ...branding, email: e.target.value })}
                placeholder="store@example.com"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp Number</label>
              <input
                type="tel"
                value={branding.whatsapp || ''}
                onChange={(e) => setBranding({ ...branding, whatsapp: e.target.value })}
                placeholder="+965 XXXX XXXX"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input
                type="tel"
                value={branding.phone || ''}
                onChange={(e) => setBranding({ ...branding, phone: e.target.value })}
                placeholder="+965 XXXX XXXX"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone (Arabic Display)</label>
              <input
                type="text"
                dir="rtl"
                value={branding.phoneAr || ''}
                onChange={(e) => setBranding({ ...branding, phoneAr: e.target.value })}
                placeholder="٩٦٥ XXXX XXXX+"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
              <textarea
                value={branding.address || ''}
                onChange={(e) => setBranding({ ...branding, address: e.target.value })}
                rows={3}
                placeholder="123 Street, City, Kuwait"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Address (Arabic)</label>
              <textarea
                dir="rtl"
                value={branding.addressAr || ''}
                onChange={(e) => setBranding({ ...branding, addressAr: e.target.value })}
                rows={3}
                placeholder="١٢٣ شارع، المدينة، الكويت"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Social Tab */}
      {activeTab === 'social' && (
        <div className="bg-white rounded-xl border p-6 space-y-6">
          {[
            { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/yourstore' },
            { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/yourstore' },
            { key: 'twitter', label: 'Twitter / X', placeholder: 'https://twitter.com/yourstore' },
            { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@yourstore' },
            { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@yourstore' },
            { key: 'snapchat', label: 'Snapchat', placeholder: 'https://snapchat.com/add/yourstore' },
          ].map((social) => (
            <div key={social.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{social.label}</label>
              <input
                type="url"
                value={(branding.socialLinks as Record<string, string>)[social.key] || ''}
                onChange={(e) => setBranding({
                  ...branding,
                  socialLinks: { ...branding.socialLinks, [social.key]: e.target.value },
                })}
                placeholder={social.placeholder}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>
          ))}
        </div>
      )}
      </div>
    </AdminLayout>
  );
}
