'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

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
        isOver
          ? 'text-destructive font-medium'
          : isClose
            ? 'text-amber-500'
            : 'text-muted-foreground'
      }`}
    >
      {len}/{max}
    </span>
  );
}

export default function StoreSeoPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('seo.page');

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
        setMessage({ type: 'success', text: t('successMessage') });
      } else {
        setMessage({
          type: 'error',
          text: error.message || t('failedMessage'),
        });
      }
    } catch {
      setMessage({ type: 'error', text: t('connectionError') });
    } finally {
      setIsSaving(false);
    }
  }

  const [isGenerating, setIsGenerating] = useState(false);

  async function handleGenerate(mode: 'fill-empty' | 'overwrite') {
    setMessage(null);
    setIsGenerating(true);
    try {
      const { data, error } = await apiPost<{
        suggestion: {
          title: string;
          titleAr: string;
          description: string;
          descriptionAr: string;
          keywords: string[];
        };
        cached: boolean;
      }>(`/api/v1/stores/${storeId}/ai/seo`, { kind: 'store' });
      if (error || !data) {
        setMessage({ type: 'error', text: error?.message || 'AI generation failed' });
        return;
      }
      const s = data.suggestion;
      setSettings(prev => ({
        ...prev,
        metaTitle: mode === 'overwrite' || !prev.metaTitle ? s.title : prev.metaTitle,
        metaTitleAr: mode === 'overwrite' || !prev.metaTitleAr ? s.titleAr : prev.metaTitleAr,
        metaDescription:
          mode === 'overwrite' || !prev.metaDescription ? s.description : prev.metaDescription,
        metaDescriptionAr:
          mode === 'overwrite' || !prev.metaDescriptionAr
            ? s.descriptionAr
            : prev.metaDescriptionAr,
      }));
      setMessage({ type: 'success', text: 'AI filled the SEO fields. Review and save.' });
    } catch {
      setMessage({ type: 'error', text: 'Network error contacting AI' });
    } finally {
      setIsGenerating(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('loading')}>
        <div className="animate-pulse space-y-4">
          <div className="h-64 rounded-xl bg-muted" />
          <div className="h-64 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link href={`/stores/${storeId}/settings`}>
            <Button type="button" variant="outline">
              {t('backToSettings')}
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => handleGenerate('fill-empty')}
            disabled={isGenerating || isSaving}
            className="inline-flex items-center gap-2 rounded-lg border border-[#fc6b02]/40 bg-[#fc6b02]/5 px-4 py-2 text-sm font-semibold text-[#fc6b02] transition-colors hover:bg-[#fc6b02]/10 disabled:cursor-not-allowed disabled:opacity-50"
            title="Generate SEO with AI — only fills empty fields"
          >
            {isGenerating ? (
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <span aria-hidden>✨</span>
            )}
            <span>{isGenerating ? 'Generating…' : 'Generate with AI'}</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? t('saving') : t('saveChanges')}
          </button>
        </div>
      }
    >
      {/* SERP Preview */}
      {settings.metaTitle && (
        <div className="mb-6 rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-medium text-foreground">{t('searchPreview')}</h2>
          <div className="rounded-lg border border-border p-4 max-w-xl">
            <p className="text-xs text-muted-foreground mb-1">{t('previewDomain')}</p>
            <p className="text-lg font-medium text-info leading-tight line-clamp-1">
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
            <div className="flex h-6 w-6 items-center justify-center rounded bg-info/10">
              <span className="text-xs font-bold text-info">{t('enBadge')}</span>
            </div>
            <h2 className="font-semibold text-foreground">{t('englishSeo')}</h2>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">{t('metaTitle')}</label>
              <CharCount value={settings.metaTitle} max={TITLE_MAX} />
            </div>
            <input
              type="text"
              value={settings.metaTitle}
              onChange={e => setSettings(prev => ({ ...prev, metaTitle: e.target.value }))}
              placeholder={t('metaTitlePlaceholder')}
              maxLength={TITLE_MAX + 20}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                settings.metaTitle.length > TITLE_MAX ? 'border-destructive/40' : 'border-border'
              }`}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('metaTitleHint', { max: TITLE_MAX })}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">{t('metaDescription')}</label>
              <CharCount value={settings.metaDescription} max={DESC_MAX} />
            </div>
            <textarea
              value={settings.metaDescription}
              onChange={e => setSettings(prev => ({ ...prev, metaDescription: e.target.value }))}
              placeholder={t('metaDescriptionPlaceholder')}
              rows={3}
              maxLength={DESC_MAX + 50}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                settings.metaDescription.length > DESC_MAX
                  ? 'border-destructive/40'
                  : 'border-border'
              }`}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('metaDescriptionHint', { max: DESC_MAX })}
            </p>
          </div>
        </div>

        {/* Arabic SEO */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-success/10">
              <span className="text-xs font-bold text-success">{t('arBadge')}</span>
            </div>
            <h2 className="font-semibold text-foreground">{t('arabicSeo')}</h2>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">{t('metaTitleAr')}</label>
              <CharCount value={settings.metaTitleAr} max={TITLE_MAX} />
            </div>
            <input
              type="text"
              lang="ar"
              dir="rtl"
              value={settings.metaTitleAr}
              onChange={e => setSettings(prev => ({ ...prev, metaTitleAr: e.target.value }))}
              placeholder={t('metaTitleArPlaceholder')}
              maxLength={TITLE_MAX + 20}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                settings.metaTitleAr.length > TITLE_MAX ? 'border-destructive/40' : 'border-border'
              }`}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-foreground">
                {t('metaDescriptionAr')}
              </label>
              <CharCount value={settings.metaDescriptionAr} max={DESC_MAX} />
            </div>
            <textarea
              lang="ar"
              dir="rtl"
              value={settings.metaDescriptionAr}
              onChange={e => setSettings(prev => ({ ...prev, metaDescriptionAr: e.target.value }))}
              placeholder={t('metaDescriptionArPlaceholder')}
              rows={3}
              maxLength={DESC_MAX + 50}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                settings.metaDescriptionAr.length > DESC_MAX
                  ? 'border-destructive/40'
                  : 'border-border'
              }`}
            />
          </div>
        </div>

        {/* Advanced */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">{t('advanced')}</h2>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('ogImage')}</label>
            <input
              type="url"
              value={settings.ogImage}
              onChange={e => setSettings(prev => ({ ...prev, ogImage: e.target.value }))}
              placeholder={t('ogImagePlaceholder')}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('ogImageHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('twitterHandle')}
              </label>
              <div className="flex">
                <span className="inline-flex items-center rounded-s-lg border border-e-0 border-border bg-muted px-3 text-sm text-muted-foreground">
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
                  placeholder={t('twitterPlaceholder')}
                  className="flex-1 rounded-e-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('googleSiteVerification')}
              </label>
              <input
                type="text"
                value={settings.googleSiteVerification}
                onChange={e =>
                  setSettings(prev => ({ ...prev, googleSiteVerification: e.target.value }))
                }
                placeholder={t('googleSiteVerificationPlaceholder')}
                className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('googleSiteVerificationHint')}
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
                : 'bg-destructive/5 border border-destructive/30 text-destructive'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
