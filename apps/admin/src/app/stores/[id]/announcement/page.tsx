'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';

interface AnnouncementSettings {
  enabled: boolean;
  text: string;
  textAr: string;
  backgroundColor: string;
  textColor: string;
  linkUrl: string;
  linkText: string;
  linkTextAr: string;
}

const DEFAULT_SETTINGS: AnnouncementSettings = {
  enabled: false,
  text: '',
  textAr: '',
  backgroundColor: '#000000',
  textColor: '#ffffff',
  linkUrl: '',
  linkText: '',
  linkTextAr: '',
};

export default function AnnouncementPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [settings, setSettings] = useState<AnnouncementSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchAnnouncement = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{ announcement?: AnnouncementSettings } | AnnouncementSettings>(
        `/api/v1/stores/${storeId}/announcement`
      );
      const announcement = (data && 'announcement' in data ? data.announcement : data) || null;
      if (announcement) {
        setSettings({ ...DEFAULT_SETTINGS, ...announcement });
      }
      // If 404 or no data, keep defaults
    } catch (err) {
      console.error('Failed to fetch announcement settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchAnnouncement();
  }, [fetchAnnouncement]);

  async function handleSave() {
    setIsSaving(true);
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/announcement`, settings);

      if (!error) {
        setMessage({ type: 'success', text: 'Announcement settings saved successfully' });
      } else {
        setMessage({
          type: 'error',
          text: error.message || 'Failed to save announcement settings',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'Unable to connect to the server' });
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title="Announcement Bar" subtitle="Loading...">
        <div className="animate-pulse space-y-4">
          <div className="h-20 rounded-xl bg-muted" />
          <div className="h-64 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Announcement Bar"
      subtitle="Display a banner across the top of your store"
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}/settings`}>
            <button className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium">
              Back to Settings
            </button>
          </Link>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      }
    >
      {/* Live Preview */}
      {settings.text && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Preview
          </p>
          <div
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg"
            style={{
              backgroundColor: settings.backgroundColor,
              color: settings.textColor,
            }}
          >
            <span>{settings.text}</span>
            {settings.linkUrl && settings.linkText && (
              <span className="underline cursor-pointer">{settings.linkText}</span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* Enable/Disable */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-foreground">Announcement Bar</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Show a banner at the top of your store for promotions, announcements or news
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={e => setSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="peer h-6 w-11 rounded-full bg-muted after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-card after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20" />
            </label>
          </div>
        </div>

        {/* Content */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">Content</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Announcement Text (English)
              </label>
              <input
                type="text"
                value={settings.text}
                onChange={e => setSettings(prev => ({ ...prev, text: e.target.value }))}
                placeholder="Free shipping on orders over 10 KWD!"
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Announcement Text (Arabic)
              </label>
              <input
                type="text"
                dir="rtl"
                value={settings.textAr}
                onChange={e => setSettings(prev => ({ ...prev, textAr: e.target.value }))}
                placeholder="شحن مجاني للطلبات فوق ١٠ د.ك!"
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Link URL (optional)
            </label>
            <input
              type="url"
              value={settings.linkUrl}
              onChange={e => setSettings(prev => ({ ...prev, linkUrl: e.target.value }))}
              placeholder="https://example.com/sale"
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The entire bar will link to this URL when clicked
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Link Text (English)
              </label>
              <input
                type="text"
                value={settings.linkText}
                onChange={e => setSettings(prev => ({ ...prev, linkText: e.target.value }))}
                placeholder="Shop Now"
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Link Text (Arabic)
              </label>
              <input
                type="text"
                dir="rtl"
                value={settings.linkTextAr}
                onChange={e => setSettings(prev => ({ ...prev, linkTextAr: e.target.value }))}
                placeholder="تسوق الآن"
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {/* Colors */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">Colors</h2>

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Background Color
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.backgroundColor}
                  onChange={e =>
                    setSettings(prev => ({ ...prev, backgroundColor: e.target.value }))
                  }
                  className="h-10 w-14 cursor-pointer rounded-lg border border-border p-1"
                />
                <input
                  type="text"
                  value={settings.backgroundColor}
                  onChange={e =>
                    setSettings(prev => ({ ...prev, backgroundColor: e.target.value }))
                  }
                  placeholder="#000000"
                  className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* Quick presets */}
              <div className="mt-2 flex gap-2">
                {['#000000', '#1f2937', '#dc2626', '#2563eb', '#16a34a', '#ea580c'].map(color => (
                  <button
                    key={color}
                    onClick={() => setSettings(prev => ({ ...prev, backgroundColor: color }))}
                    className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                      settings.backgroundColor === color
                        ? 'border-foreground scale-110'
                        : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">Text Color</label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.textColor}
                  onChange={e => setSettings(prev => ({ ...prev, textColor: e.target.value }))}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-border p-1"
                />
                <input
                  type="text"
                  value={settings.textColor}
                  onChange={e => setSettings(prev => ({ ...prev, textColor: e.target.value }))}
                  placeholder="#ffffff"
                  className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* Quick presets */}
              <div className="mt-2 flex gap-2">
                {['#ffffff', '#f3f4f6', '#fef08a', '#fbbf24', '#000000'].map(color => (
                  <button
                    key={color}
                    onClick={() => setSettings(prev => ({ ...prev, textColor: color }))}
                    className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                      settings.textColor === color ? 'border-foreground scale-110' : 'border-border'
                    }`}
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Save message */}
        {message && (
          <div
            className={`rounded-xl p-4 text-sm ${
              message.type === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
