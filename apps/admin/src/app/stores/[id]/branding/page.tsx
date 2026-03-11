'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ImageUpload } from '../../../../components/ImageUpload';
import { useToast } from '@force/ui';
import { apiGet, apiPut } from '../../../../lib/api';

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

// Convert hex to HSL space-separated string (for Tailwind CSS vars)
function hexToHsl(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return `0 0% ${Math.round(l * 100)}%`;

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / d + 2) / 6;
  else hue = ((r - g) / d + 4) / 6;

  return `${Math.round(hue * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// Convert HSL space-separated string to hex
function hslToHex(hsl: string): string {
  const parts = hsl.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return '#000000';

  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;

  if (s === 0) {
    const v = Math.round(l * 255);
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

const colorPresets = [
  { name: 'Orange', hex: '#FF6600' },
  { name: 'Blue', hex: '#3B82F6' },
  { name: 'Green', hex: '#16A34A' },
  { name: 'Purple', hex: '#7C3AED' },
  { name: 'Rose', hex: '#E11D48' },
  { name: 'Teal', hex: '#0D9488' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Black', hex: '#171717' },
];

export default function StoreBrandingPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const toast = useToast();

  const [branding, setBranding] = useState<StoreBranding | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'branding' | 'theme' | 'contact' | 'social'>(
    'branding'
  );

  useEffect(() => {
    fetchBranding();
  }, [storeId]);

  async function fetchBranding() {
    try {
      interface StoreResponse {
        id: string;
        name: string;
        nameAr?: string;
        logo?: string;
        logoAr?: string;
        favicon?: string;
        description?: string;
        descriptionAr?: string;
        theme?: Partial<StoreTheme>;
        email?: string;
        phone?: string;
        phoneAr?: string;
        whatsapp?: string;
        address?: string;
        addressAr?: string;
        socialLinks?: StoreBranding['socialLinks'];
      }

      const { data, error: apiError } = await apiGet<{ store: StoreResponse }>(
        `/api/v1/stores/${storeId}`
      );

      if (apiError) {
        toast.error(
          'Failed to load branding',
          apiError.message || `Server error: ${apiError.status}`
        );
        return;
      }

      if (data?.store) {
        const store = data.store;
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
      toast.error('Connection error', 'Failed to connect to the server');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    if (!branding) return;

    setIsSaving(true);
    try {
      const basePath = `/api/v1/stores/${storeId}`;

      const [brandingResult, themeResult, contactResult, socialResult] = await Promise.all([
        apiPut(`${basePath}/branding`, {
          name: branding.name,
          nameAr: branding.nameAr,
          logo: branding.logo,
          logoAr: branding.logoAr,
          favicon: branding.favicon,
          description: branding.description,
          descriptionAr: branding.descriptionAr,
        }),
        apiPut(`${basePath}/theme`, branding.theme),
        apiPut(`${basePath}/contact`, {
          email: branding.email,
          phone: branding.phone,
          phoneAr: branding.phoneAr,
          whatsapp: branding.whatsapp,
          address: branding.address,
          addressAr: branding.addressAr,
        }),
        apiPut(`${basePath}/social`, branding.socialLinks),
      ]);

      // Check for failures
      const failed = [
        { name: 'Branding', result: brandingResult },
        { name: 'Theme', result: themeResult },
        { name: 'Contact', result: contactResult },
        { name: 'Social', result: socialResult },
      ].filter(r => r.result.error !== null);

      if (failed.length > 0) {
        const first = failed[0];
        const err = first.result.error;
        if (err?.status === 403) {
          toast.error('Access denied', 'You do not have permission to update this store');
        } else if (err?.status === 401) {
          toast.error('Session expired', 'Please log in again');
        } else {
          toast.error(`Failed to save ${first.name.toLowerCase()}`, err?.message || 'Server error');
        }
        return;
      }

      toast.success('Branding saved', 'All changes have been saved successfully');
    } catch (error) {
      console.error('Failed to save branding:', error);
      toast.error('Connection error', 'Failed to connect to the server. Please try again.');
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
        <div className="flex gap-2 border-b border-border">
          {[
            { id: 'branding', label: 'Branding' },
            { id: 'theme', label: 'Theme & Colors' },
            { id: 'contact', label: 'Contact Info' },
            { id: 'social', label: 'Social Links' },
          ].map(tab => (
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
          <div className="bg-card rounded-xl border p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Store Name</label>
                <input
                  type="text"
                  value={branding.name}
                  onChange={e => setBranding({ ...branding, name: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Store Name (Arabic)
                </label>
                <input
                  type="text"
                  dir="rtl"
                  value={branding.nameAr || ''}
                  onChange={e => setBranding({ ...branding, nameAr: e.target.value })}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Logo</label>
                <ImageUpload
                  value={branding.logo}
                  onUpload={url => setBranding({ ...branding, logo: url })}
                  onRemove={() => setBranding({ ...branding, logo: '' })}
                  folder="branding"
                  label="Upload Logo"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Logo (Arabic)
                </label>
                <ImageUpload
                  value={branding.logoAr}
                  onUpload={url => setBranding({ ...branding, logoAr: url })}
                  onRemove={() => setBranding({ ...branding, logoAr: '' })}
                  folder="branding"
                  label="Upload Arabic Logo"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Favicon</label>
                <ImageUpload
                  value={branding.favicon}
                  onUpload={url => setBranding({ ...branding, favicon: url })}
                  onRemove={() => setBranding({ ...branding, favicon: '' })}
                  folder="branding"
                  label="Upload Favicon"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={branding.description || ''}
                  onChange={e => setBranding({ ...branding, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (Arabic)
                </label>
                <textarea
                  dir="rtl"
                  value={branding.descriptionAr || ''}
                  onChange={e => setBranding({ ...branding, descriptionAr: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
                />
              </div>
            </div>
          </div>
        )}

        {/* Theme Tab */}
        {activeTab === 'theme' && (
          <div className="bg-card rounded-xl border p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">Primary Color</label>
              <div className="flex flex-wrap gap-3">
                {colorPresets.map(preset => {
                  const currentHex = hslToHex(branding.theme.primaryColor).toUpperCase();
                  const isSelected = currentHex === preset.hex.toUpperCase();
                  return (
                    <button
                      key={preset.name}
                      onClick={() =>
                        setBranding({
                          ...branding,
                          theme: { ...branding.theme, primaryColor: hexToHsl(preset.hex) },
                        })
                      }
                      className={`w-10 h-10 rounded-full border-2 transition-all ${
                        isSelected
                          ? 'border-gray-900 scale-110'
                          : 'border-transparent hover:scale-105'
                      }`}
                      style={{ backgroundColor: preset.hex }}
                      title={`${preset.name} (${preset.hex})`}
                    />
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input
                  type="color"
                  value={hslToHex(branding.theme.primaryColor)}
                  onChange={e =>
                    setBranding({
                      ...branding,
                      theme: { ...branding.theme, primaryColor: hexToHsl(e.target.value) },
                    })
                  }
                  className="w-10 h-10 rounded-lg border border-border cursor-pointer p-0.5"
                />
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">HEX</label>
                  <input
                    type="text"
                    value={hslToHex(branding.theme.primaryColor).toUpperCase()}
                    onChange={e => {
                      const v = e.target.value;
                      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                        setBranding({
                          ...branding,
                          theme: { ...branding.theme, primaryColor: hexToHsl(v) },
                        });
                      }
                    }}
                    placeholder="#FF6600"
                    maxLength={7}
                    className="w-24 px-3 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono text-sm"
                  />
                </div>
                {(['r', 'g', 'b'] as const).map(channel => {
                  const rgb = hexToRgb(hslToHex(branding.theme.primaryColor));
                  return (
                    <div key={channel}>
                      <label className="block text-[10px] text-gray-400 mb-0.5">
                        {channel.toUpperCase()}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={rgb[channel]}
                        onChange={e => {
                          const val = parseInt(e.target.value, 10) || 0;
                          const newRgb = { ...rgb, [channel]: val };
                          const hex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
                          setBranding({
                            ...branding,
                            theme: { ...branding.theme, primaryColor: hexToHsl(hex) },
                          });
                        }}
                        className="w-16 px-2 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm text-center"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Secondary Color
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="color"
                  value={hslToHex(branding.theme.secondaryColor)}
                  onChange={e =>
                    setBranding({
                      ...branding,
                      theme: { ...branding.theme, secondaryColor: hexToHsl(e.target.value) },
                    })
                  }
                  className="w-10 h-10 rounded-lg border border-border cursor-pointer p-0.5"
                />
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">HEX</label>
                  <input
                    type="text"
                    value={hslToHex(branding.theme.secondaryColor).toUpperCase()}
                    onChange={e => {
                      const v = e.target.value;
                      if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                        setBranding({
                          ...branding,
                          theme: { ...branding.theme, secondaryColor: hexToHsl(v) },
                        });
                      }
                    }}
                    placeholder="#F3F4F6"
                    maxLength={7}
                    className="w-24 px-3 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono text-sm"
                  />
                </div>
                {(['r', 'g', 'b'] as const).map(channel => {
                  const rgb = hexToRgb(hslToHex(branding.theme.secondaryColor));
                  return (
                    <div key={channel}>
                      <label className="block text-[10px] text-gray-400 mb-0.5">
                        {channel.toUpperCase()}
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={255}
                        value={rgb[channel]}
                        onChange={e => {
                          const val = parseInt(e.target.value, 10) || 0;
                          const newRgb = { ...rgb, [channel]: val };
                          const hex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
                          setBranding({
                            ...branding,
                            theme: { ...branding.theme, secondaryColor: hexToHsl(hex) },
                          });
                        }}
                        className="w-16 px-2 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm text-center"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Font Family</label>
                <select
                  value={branding.theme.fontFamily}
                  onChange={e =>
                    setBranding({
                      ...branding,
                      theme: { ...branding.theme, fontFamily: e.target.value },
                    })
                  }
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                >
                  {fontOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Border Radius
                </label>
                <select
                  value={branding.theme.borderRadius}
                  onChange={e =>
                    setBranding({
                      ...branding,
                      theme: { ...branding.theme, borderRadius: e.target.value },
                    })
                  }
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                >
                  {borderRadiusOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Preview */}
            <div className="mt-8 pt-6 border-t">
              <h3 className="text-sm font-medium text-gray-700 mb-4">Preview</h3>
              <div
                className="p-6 bg-muted rounded-xl"
                style={{ '--primary': branding.theme.primaryColor } as React.CSSProperties}
              >
                <div className="flex items-center gap-4 mb-4">
                  <button
                    className="px-4 py-2 text-white rounded-lg"
                    style={{ backgroundColor: `hsl(${branding.theme.primaryColor})` }}
                  >
                    Primary Button
                  </button>
                  <button className="px-4 py-2 border border-border rounded-lg hover:bg-gray-100">
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
          <div className="bg-card rounded-xl border p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={branding.email || ''}
                  onChange={e => setBranding({ ...branding, email: e.target.value })}
                  placeholder="store@example.com"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  WhatsApp Number
                </label>
                <input
                  type="tel"
                  value={branding.whatsapp || ''}
                  onChange={e => setBranding({ ...branding, whatsapp: e.target.value })}
                  placeholder="+965 XXXX XXXX"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="tel"
                  value={branding.phone || ''}
                  onChange={e => setBranding({ ...branding, phone: e.target.value })}
                  placeholder="+965 XXXX XXXX"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone (Arabic Display)
                </label>
                <input
                  type="text"
                  dir="rtl"
                  value={branding.phoneAr || ''}
                  onChange={e => setBranding({ ...branding, phoneAr: e.target.value })}
                  placeholder="٩٦٥ XXXX XXXX+"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <textarea
                  value={branding.address || ''}
                  onChange={e => setBranding({ ...branding, address: e.target.value })}
                  rows={3}
                  placeholder="123 Street, City, Kuwait"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Address (Arabic)
                </label>
                <textarea
                  dir="rtl"
                  value={branding.addressAr || ''}
                  onChange={e => setBranding({ ...branding, addressAr: e.target.value })}
                  rows={3}
                  placeholder="١٢٣ شارع، المدينة، الكويت"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
                />
              </div>
            </div>
          </div>
        )}

        {/* Social Tab */}
        {activeTab === 'social' && (
          <div className="bg-card rounded-xl border p-6 space-y-6">
            {[
              {
                key: 'instagram',
                label: 'Instagram',
                placeholder: 'https://instagram.com/yourstore',
              },
              { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/yourstore' },
              {
                key: 'twitter',
                label: 'Twitter / X',
                placeholder: 'https://twitter.com/yourstore',
              },
              { key: 'tiktok', label: 'TikTok', placeholder: 'https://tiktok.com/@yourstore' },
              { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@yourstore' },
              {
                key: 'snapchat',
                label: 'Snapchat',
                placeholder: 'https://snapchat.com/add/yourstore',
              },
            ].map(social => (
              <div key={social.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {social.label}
                </label>
                <input
                  type="url"
                  value={(branding.socialLinks as Record<string, string>)[social.key] || ''}
                  onChange={e =>
                    setBranding({
                      ...branding,
                      socialLinks: { ...branding.socialLinks, [social.key]: e.target.value },
                    })
                  }
                  placeholder={social.placeholder}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
