'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';

interface SeoSettings {
  metaTitle: string;
  metaTitleAr: string;
  metaDescription: string;
  metaDescriptionAr: string;
  ogImage: string;
  twitterHandle: string;
  googleSiteVerification: string;
}

const DEFAULT_SETTINGS: SeoSettings = {
  metaTitle: '',
  metaTitleAr: '',
  metaDescription: '',
  metaDescriptionAr: '',
  ogImage: '',
  twitterHandle: '',
  googleSiteVerification: '',
};

// Character limits for SEO best practices
const TITLE_MAX = 60;
const DESC_MAX = 160;

function CharCount({ value, max }: { value: string; max: number }) {
  const len = value.length;
  const isOver = len > max;
  const isClose = len > max * 0.85;
  return (
    <span
      className={`text-xs ${
        isOver ? 'text-red-500 font-medium' : isClose ? 'text-amber-500' : 'text-muted-foreground'
      }`}
    >
      {len}/{max}
    </span>
  );
}

export default function StoreSeoPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [settings, setSettings] = useState<SeoSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchSeo = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const { data } = await apiGet<{ seo?: Partial<SeoSettings> }>(
        `/api/v1/stores/${storeId}/seo`
      );
      const seo: Partial<SeoSettings> | null =
        (data?.seo ?? (data as unknown as Partial<SeoSettings>)) || null;
      if (seo) {
        setSettings({
          metaTitle: seo.metaTitle || '',
          metaTitleAr: seo.metaTitleAr || '',
          metaDescription: seo.metaDescription || '',
          metaDescriptionAr: seo.metaDescriptionAr || '',
          ogImage: seo.ogImage || '',
          twitterHandle: seo.twitterHandle || '',
          googleSiteVerification: seo.googleSiteVerification || '',
        });
      }
      // If 404 or no data, keep defaults
    } catch (err) {
      console.error('Failed to fetch SEO settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchSeo();
  }, [fetchSeo]);

  async function handleSave() {
    setIsSaving(true);
    setMessage(null);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/seo`, settings);

      if (!error) {
        setMessage({ type: 'success', text: 'SEO settings saved successfully' });
      } else {
        setMessage({
          type: 'error',
          text: error.message || 'Failed to save SEO settings',
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
      <AdminLayout title="SEO Settings" subtitle="Loading...">
        <div className="animate-pulse space-y-4">
          <div className="h-64 rounded-xl bg-muted" />
          <div className="h-64 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="SEO Settings"
      subtitle="Optimize your store for search engines"
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
      {/* SERP Preview */}
      {settings.metaTitle && (
        <div className="mb-6 rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-medium text-foreground">Search Result Preview</h2>
          <div className="rounded-lg border border-border p-4 max-w-xl">
            <p className="text-xs text-muted-foreground mb-1">example.com</p>
            <p className="text-lg font-medium text-blue-700 leading-tight line-clamp-1">
              {settings.metaTitle}
            </p>
            {settings.metaDescription && (
              <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                {settings.metaDescription}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* English SEO */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-blue-100">
              <span className="text-xs font-bold text-blue-600">EN</span>
            </div>
            <h2 className="font-semibold text-foreground">English SEO</h2>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">Meta Title</label>
              <CharCount value={settings.metaTitle} max={TITLE_MAX} />
            </div>
            <input
              type="text"
              value={settings.metaTitle}
              onChange={e => setSettings(prev => ({ ...prev, metaTitle: e.target.value }))}
              placeholder="My Store — Best Products in Kuwait"
              maxLength={TITLE_MAX + 20}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                settings.metaTitle.length > TITLE_MAX ? 'border-red-300' : 'border-border'
              }`}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Appears in browser tabs and search results. Keep under {TITLE_MAX} characters for best
              results.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">Meta Description</label>
              <CharCount value={settings.metaDescription} max={DESC_MAX} />
            </div>
            <textarea
              value={settings.metaDescription}
              onChange={e => setSettings(prev => ({ ...prev, metaDescription: e.target.value }))}
              placeholder="Discover our wide range of products with fast delivery across Kuwait..."
              rows={3}
              maxLength={DESC_MAX + 50}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                settings.metaDescription.length > DESC_MAX ? 'border-red-300' : 'border-border'
              }`}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Shown in search result snippets. Keep under {DESC_MAX} characters for best results.
            </p>
          </div>
        </div>

        {/* Arabic SEO */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-green-100">
              <span className="text-xs font-bold text-green-600">AR</span>
            </div>
            <h2 className="font-semibold text-foreground">Arabic SEO</h2>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">Meta Title (Arabic)</label>
              <CharCount value={settings.metaTitleAr} max={TITLE_MAX} />
            </div>
            <input
              type="text"
              dir="rtl"
              value={settings.metaTitleAr}
              onChange={e => setSettings(prev => ({ ...prev, metaTitleAr: e.target.value }))}
              placeholder="متجري — أفضل المنتجات في الكويت"
              maxLength={TITLE_MAX + 20}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                settings.metaTitleAr.length > TITLE_MAX ? 'border-red-300' : 'border-border'
              }`}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">
                Meta Description (Arabic)
              </label>
              <CharCount value={settings.metaDescriptionAr} max={DESC_MAX} />
            </div>
            <textarea
              dir="rtl"
              value={settings.metaDescriptionAr}
              onChange={e => setSettings(prev => ({ ...prev, metaDescriptionAr: e.target.value }))}
              placeholder="اكتشف مجموعتنا الواسعة من المنتجات مع توصيل سريع في الكويت..."
              rows={3}
              maxLength={DESC_MAX + 50}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                settings.metaDescriptionAr.length > DESC_MAX ? 'border-red-300' : 'border-border'
              }`}
            />
          </div>
        </div>

        {/* Advanced */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">Advanced</h2>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">OG Image URL</label>
            <input
              type="url"
              value={settings.ogImage}
              onChange={e => setSettings(prev => ({ ...prev, ogImage: e.target.value }))}
              placeholder="https://example.com/og-image.jpg"
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Image shown when your store is shared on social media. Recommended: 1200×630px.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Twitter / X Handle
              </label>
              <div className="flex">
                <span className="inline-flex items-center rounded-l-lg border border-r-0 border-border bg-muted px-3 text-sm text-muted-foreground">
                  @
                </span>
                <input
                  type="text"
                  value={settings.twitterHandle.replace('@', '')}
                  onChange={e =>
                    setSettings(prev => ({
                      ...prev,
                      twitterHandle: e.target.value.replace('@', ''),
                    }))
                  }
                  placeholder="yourstorehandle"
                  className="flex-1 rounded-r-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Google Site Verification
              </label>
              <input
                type="text"
                value={settings.googleSiteVerification}
                onChange={e =>
                  setSettings(prev => ({ ...prev, googleSiteVerification: e.target.value }))
                }
                placeholder="Verification meta tag content"
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                From Google Search Console verification
              </p>
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
