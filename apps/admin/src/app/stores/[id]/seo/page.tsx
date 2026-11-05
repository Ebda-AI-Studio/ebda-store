'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, unwrapObject } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '../../../../components/ImageUpload';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { arabicInEnglishFields, normalizeLanguagePair } from './language-guard';

interface SeoSettings {
  metaTitle: string;
  metaTitleAr: string;
  metaDescription: string;
  metaDescriptionAr: string;
  metaDescriptionAeo: string;
  metaDescriptionAeoAr: string;
  ogImage: string;
  twitterHandle: string;
  googleSiteVerification: string;
  emailSenderLocalPart: string;
}

interface SocialLinks {
  wikidata: string;
  wikipedia: string;
  instagram: string;
  tiktok: string;
  linkedin: string;
  facebook: string;
  youtube: string;
  twitter: string;
}

const DEFAULT_SOCIAL: SocialLinks = {
  wikidata: '',
  wikipedia: '',
  instagram: '',
  tiktok: '',
  linkedin: '',
  facebook: '',
  youtube: '',
  twitter: '',
};

function isValidUrl(value: string): boolean {
  if (!value.trim()) return true; // empty is valid
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SETTINGS: SeoSettings = {
  metaTitle: '',
  metaTitleAr: '',
  metaDescription: '',
  metaDescriptionAr: '',
  metaDescriptionAeo: '',
  metaDescriptionAeoAr: '',
  ogImage: '',
  twitterHandle: '',
  googleSiteVerification: '',
  emailSenderLocalPart: 'orders',
};

// Approved sender prefixes (mirrors MERCHANT_SENDER_PREFIXES in apps/api/src/services/email-sender.ts;
// the API rejects anything else). The address is <prefix>.<your-store-slug>@ebda.app.
const SENDER_PREFIXES: string[] = ['orders', 'receipts', 'hello', 'info', 'support'];

// Character limits for SEO best practices
const TITLE_MAX = 60;
const DESC_MAX = 160;

// Pull the token out if the merchant pasted the entire
// `<meta name="google-site-verification" content="..." />` tag.
function extractGoogleVerificationToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const tagMatch = trimmed.match(/content\s*=\s*["']([^"']+)["']/i);
  return tagMatch ? tagMatch[1].trim() : trimmed;
}

function CharCount({ value, max }: { value: string; max: number }) {
  const len = value.length;
  const isOver = len > max;
  const isClose = len > max * 0.85;
  return (
    <span
      className={`text-xs ${
        isOver
          ? 'text-destructive-ink font-medium'
          : isClose
            ? 'text-warning-ink'
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
  const router = useRouter();

  const [settings, setSettings] = useState<SeoSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();
  // The store's default language decides which language block (and which Google preview) comes first.
  const [defaultLang, setDefaultLang] = useState<'ar' | 'en'>('ar');
  const [baseline, setBaseline] = useState<string | null>(null);

  // Social & Knowledge Graph state
  const [socialLinks, setSocialLinks] = useState<SocialLinks>(DEFAULT_SOCIAL);

  const fetchSeo = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const [seoRes, storeRes] = await Promise.all([
        apiGet<{ seo?: Partial<SeoSettings> }>(`/api/v1/stores/${storeId}/seo`),
        apiGet<{
          store?: { socialLinks?: Partial<SocialLinks>; settings?: { defaultLanguage?: string } };
        }>(`/api/v1/stores/${storeId}`),
      ]);

      const loadedLang = (
        storeRes.data as { store?: { settings?: { defaultLanguage?: string } } } | null
      )?.store?.settings?.defaultLanguage;
      if (loadedLang === 'en' || loadedLang === 'ar') setDefaultLang(loadedLang);

      const seoData = seoRes.data;
      const seo: Partial<SeoSettings> | null =
        (seoData?.seo ?? (seoData as unknown as Partial<SeoSettings>)) || null;
      let loadedSettings = DEFAULT_SETTINGS;
      if (seo) {
        loadedSettings = {
          metaTitle: seo.metaTitle || '',
          metaTitleAr: seo.metaTitleAr || '',
          metaDescription: seo.metaDescription || '',
          metaDescriptionAr: seo.metaDescriptionAr || '',
          metaDescriptionAeo: (seo as SeoSettings).metaDescriptionAeo || '',
          metaDescriptionAeoAr: (seo as SeoSettings).metaDescriptionAeoAr || '',
          ogImage: seo.ogImage || '',
          twitterHandle: seo.twitterHandle || '',
          googleSiteVerification: seo.googleSiteVerification || '',
          emailSenderLocalPart: SENDER_PREFIXES.includes(seo.emailSenderLocalPart ?? '')
            ? (seo.emailSenderLocalPart as string)
            : 'orders',
        };
        setSettings(loadedSettings);
      }

      const storeBody = unwrapObject<{
        store?: { socialLinks?: Record<string, string> };
        socialLinks?: Record<string, string>;
      }>(storeRes.data);
      const rawSocial: Record<string, string> =
        storeBody?.store?.socialLinks ?? storeBody?.socialLinks ?? {};
      const loadedSocial: SocialLinks = {
        wikidata: rawSocial.wikidata || '',
        wikipedia: rawSocial.wikipedia || '',
        instagram: rawSocial.instagram || '',
        tiktok: rawSocial.tiktok || '',
        linkedin: rawSocial.linkedin || '',
        facebook: rawSocial.facebook || '',
        youtube: rawSocial.youtube || '',
        twitter: rawSocial.twitter || '',
      };
      setSocialLinks(loadedSocial);
      setBaseline(JSON.stringify([loadedSettings, loadedSocial.wikidata, loadedSocial.wikipedia]));
    } catch (err) {
      console.error('Failed to fetch SEO settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchSeo();
  }, [fetchSeo]);

  // The FAQs and how-to guides moved to Content: old `#faqs` / `#howtos` links land on the new page.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (['#faqs', '#howtos'].includes(window.location.hash)) {
      router.replace(`/stores/${storeId}/content/faqs`);
    }
  }, [router, storeId]);

  const snapshot = useMemo(
    () => JSON.stringify([settings, socialLinks.wikidata, socialLinks.wikipedia]),
    [settings, socialLinks.wikidata, socialLinks.wikipedia]
  );
  const dirty = baseline !== null && snapshot !== baseline;

  // One Save for the page (rule 5): the SEO fields and the knowledge-graph links go out together.
  async function handleSave() {
    const wrongLanguage = arabicInEnglishFields(settings);
    if (wrongLanguage.length > 0) {
      const names = wrongLanguage.map(k => t(`languageGuardField.${k}`)).join('، ');
      toastError(t('languageGuardTitle'), t('languageGuardBody', { fields: names }));
      return;
    }
    // Only the knowledge-graph links (wikidata + wikipedia) are edited here; the social platforms live in Branding.
    const wikiPayload = Object.fromEntries(
      (['wikidata', 'wikipedia'] as const)
        .map(k => [k, socialLinks[k].trim()] as [string, string])
        .filter(([, v]) => v === '' || isValidUrl(v))
    );
    if (
      (['wikidata', 'wikipedia'] as const).some(
        k => socialLinks[k].trim() !== '' && !isValidUrl(socialLinks[k])
      )
    ) {
      toastError(t('socialSaveError'), '');
      return;
    }
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/seo`, settings);
      if (error) {
        toastError(t('failedMessage'), error.message || '');
        return;
      }
      const { error: socialError } = await apiPut(`/api/v1/stores/${storeId}/social`, wikiPayload);
      if (socialError) {
        toastError(t('socialSaveError'), socialError.message || '');
        return;
      }
      setBaseline(snapshot);
      toastSuccess(t('successMessage'), '');
    } catch {
      toastError(t('connectionError'), '');
    } finally {
      setIsSaving(false);
    }
  }

  const [isGenerating, setIsGenerating] = useState(false);

  // "اكتب لي الوصف" lives inside the field group (UX:SEO-1). Fills only the empty fields unless told to overwrite.
  async function handleGenerate(mode: 'fill-empty' | 'overwrite') {
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
        toastError(t('aiFailedTitle'), error?.message || t('aiFailedBody'));
        return;
      }
      const s = data.suggestion;
      // The AI sometimes answers with the two languages swapped: put each text back in its own field (QA P2-1).
      const title = normalizeLanguagePair(s.title, s.titleAr);
      const description = normalizeLanguagePair(s.description, s.descriptionAr);
      const targets: Array<[keyof SeoSettings, string]> = [
        ['metaTitle', title.en],
        ['metaTitleAr', title.ar],
        ['metaDescription', description.en],
        ['metaDescriptionAr', description.ar],
      ];
      const next = { ...settings };
      const filled: string[] = [];
      for (const [field, value] of targets) {
        if (value === '') continue;
        if (mode === 'overwrite' || !settings[field]) {
          next[field] = value;
          filled.push(t(`aiField.${field}`));
        }
      }
      if (filled.length === 0) {
        toastSuccess(t('aiNothingToFillTitle'), t('aiNothingToFillBody'));
        return;
      }
      setSettings(next);
      toastSuccess(t('aiFilledTitle'), t('aiFilledBody', { fields: filled.join('، ') }));
    } catch {
      toastError(t('aiFailedTitle'), t('aiFailedBody'));
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

  const previewTitle =
    defaultLang === 'ar'
      ? settings.metaTitleAr || settings.metaTitle
      : settings.metaTitle || settings.metaTitleAr;
  const previewDescription =
    defaultLang === 'ar'
      ? settings.metaDescriptionAr || settings.metaDescription
      : settings.metaDescription || settings.metaDescriptionAr;

  const englishBlock = (
    <div key="en">
      {/* English SEO */}
      <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-info/10">
            <span className="text-xs font-bold text-info-ink">{t('enBadge')}</span>
          </div>
          <h2 className="font-semibold text-foreground">{t('englishSeo')}</h2>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label data-setting-id="seo.meta-title" className="text-sm font-medium text-foreground">
              {t('metaTitle')}
            </label>
            <CharCount value={settings.metaTitle} max={TITLE_MAX} />
          </div>
          <input
            type="text"
            value={settings.metaTitle}
            onChange={e => setSettings(prev => ({ ...prev, metaTitle: e.target.value }))}
            placeholder={t('metaTitlePlaceholder')}
            maxLength={TITLE_MAX + 20}
            className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
              settings.metaTitle.length > TITLE_MAX ? 'border-destructive/40' : 'border-input'
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
              settings.metaDescription.length > DESC_MAX ? 'border-destructive/40' : 'border-input'
            }`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t('metaDescriptionHint', { max: DESC_MAX })}
          </p>
        </div>
      </div>
    </div>
  );
  const arabicBlock = (
    <div key="ar">
      {/* Arabic SEO */}
      <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-success/10">
            <span className="text-xs font-bold text-success-ink">{t('arBadge')}</span>
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
              settings.metaTitleAr.length > TITLE_MAX ? 'border-destructive/40' : 'border-input'
            }`}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium text-foreground">{t('metaDescriptionAr')}</label>
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
                : 'border-input'
            }`}
          />
        </div>
      </div>
    </div>
  );

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} storeId={storeId}>
      <div className="space-y-6 pb-24">
        <p className="text-sm text-muted-foreground">
          {t('redirectsPrompt')}{' '}
          <Link
            href={`/stores/${storeId}/seo/redirects`}
            className="font-medium text-primary-ink underline underline-offset-2"
          >
            {t('manageRedirects')}
          </Link>
          {' · '}
          <Link
            href={`/stores/${storeId}/content/faqs`}
            className="font-medium text-primary-ink underline underline-offset-2"
          >
            {t('faqsMovedLink')}
          </Link>
        </p>

        {/* How the store looks on Google, in the store's own default language */}
        {previewTitle && (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-medium text-foreground">{t('searchPreview')}</h2>
            <div
              className="max-w-xl rounded-lg border border-border p-4"
              dir={defaultLang === 'ar' ? 'rtl' : 'ltr'}
            >
              <p className="mb-1 text-xs text-muted-foreground">{t('previewDomain')}</p>
              <p className="line-clamp-1 text-lg font-medium leading-tight text-info-ink">
                {previewTitle}
              </p>
              {previewDescription && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {previewDescription}
                </p>
              )}
            </div>
          </div>
        )}

        {/* The AI helper sits with the fields it fills (UX:SEO-1) */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-card p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('aiGenerateTooltip')}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => handleGenerate('fill-empty')}
            disabled={isGenerating || isSaving}
            isLoading={isGenerating}
          >
            {isGenerating ? t('generating') : t('generateWithAi')}
          </Button>
        </div>

        {defaultLang === 'ar' ? (
          <>
            {arabicBlock}
            {englishBlock}
          </>
        ) : (
          <>
            {englishBlock}
            {arabicBlock}
          </>
        )}

        {/* "متقدم": the AI-answer copy, social card image, verification and sender (UX:SEO-3) */}
        <details className="rounded-xl border bg-card p-4 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">
            {t('advancedGroup')}
          </summary>
          <div className="mt-4 space-y-6">
            {/* AEO — Conversational Answer Engine copy */}
            <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded bg-primary/10">
                  {/* i18n-gate-allow: acronym badge */}
                  <span className="text-xs font-bold text-primary">AEO</span>
                </div>
                <div>
                  <h2 data-setting-id="seo.aeo" className="font-semibold text-foreground">
                    {t('aeoTitle')}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('aeoHint')}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-foreground">{t('aeoLabelEn')}</label>
                  <CharCount value={settings.metaDescriptionAeo} max={DESC_MAX} />
                </div>
                <textarea
                  value={settings.metaDescriptionAeo}
                  onChange={e =>
                    setSettings(prev => ({ ...prev, metaDescriptionAeo: e.target.value }))
                  }
                  placeholder={t('aeoPlaceholderEn')}
                  rows={3}
                  maxLength={DESC_MAX + 50}
                  className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                    settings.metaDescriptionAeo.length > DESC_MAX
                      ? 'border-destructive/40'
                      : 'border-input'
                  }`}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t('aeoHintText')}</p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-foreground">{t('aeoLabelAr')}</label>
                  <CharCount value={settings.metaDescriptionAeoAr} max={DESC_MAX} />
                </div>
                <textarea
                  lang="ar"
                  dir="rtl"
                  value={settings.metaDescriptionAeoAr}
                  onChange={e =>
                    setSettings(prev => ({ ...prev, metaDescriptionAeoAr: e.target.value }))
                  }
                  placeholder={t('aeoPlaceholderAr')}
                  rows={3}
                  maxLength={DESC_MAX + 50}
                  className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                    settings.metaDescriptionAeoAr.length > DESC_MAX
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
                {/* SEC-6: the API only accepts an image from our media library, so upload it here. */}
                <ImageUpload
                  value={settings.ogImage}
                  onUpload={url => setSettings(prev => ({ ...prev, ogImage: url }))}
                  onRemove={() => setSettings(prev => ({ ...prev, ogImage: '' }))}
                  folder="branding"
                  storeId={storeId}
                  label={t('ogImage')}
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
                      className="flex-1 rounded-e-lg border border-input px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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
                      setSettings(prev => ({
                        ...prev,
                        googleSiteVerification: extractGoogleVerificationToken(e.target.value),
                      }))
                    }
                    placeholder={t('googleSiteVerificationPlaceholder')}
                    className="w-full rounded-lg border border-input px-4 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="mt-1 text-xs text-muted-foreground whitespace-pre-line">
                    {t('googleSiteVerificationHint')}
                  </p>
                  {settings.googleSiteVerification && (
                    <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                      {/* i18n-gate-allow: HTML meta tag sample, code not copy */}
                      {`<meta name="google-site-verification" content="${settings.googleSiteVerification}" />`}
                    </pre>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {t('senderPrefix')}
                  </label>
                  <div className="flex items-center rounded-lg border border-border overflow-hidden">
                    <select
                      value={settings.emailSenderLocalPart}
                      onChange={e =>
                        setSettings(prev => ({ ...prev, emailSenderLocalPart: e.target.value }))
                      }
                      className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none"
                    >
                      {SENDER_PREFIXES.map(p => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <span className="bg-muted px-3 py-2 text-sm text-muted-foreground" dir="ltr">
                      {/* i18n-gate-allow: mail address template token */}.{'{store}'}@ebda.app
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('senderPrefixHint')}</p>
                </div>
              </div>
            </div>

            {/* ===== Knowledge Graph (Wikidata / Wikipedia) ===== */}
            {/* Social platform URLs (Instagram, Facebook, TikTok, etc.) are edited
            in Branding → Social to avoid duplication. Only knowledge-graph
            fields — wikidata + wikipedia — remain here because they are
            genuinely SEO-specific structured-data signals, not social links. */}
            <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-foreground">{t('socialTitle')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('socialSubtitle')}</p>
                </div>
              </div>

              {/* Knowledge graph fields — highest-value structured-data signals */}
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    {
                      key: 'wikidata',
                      labelKey: 'socialWikidata',
                      placeholderKey: 'socialWikidataPlaceholder',
                      hintKey: 'socialWikidataHint',
                    },
                    {
                      key: 'wikipedia',
                      labelKey: 'socialWikipedia',
                      placeholderKey: 'socialWikipediaPlaceholder',
                      hintKey: 'socialWikipediaHint',
                    },
                  ] as const
                ).map(({ key, labelKey, placeholderKey, hintKey }) => (
                  <div key={key}>
                    <label className="block text-sm font-medium text-foreground mb-1">
                      {t(labelKey)}
                    </label>
                    <input
                      type="url"
                      value={socialLinks[key]}
                      onChange={e => setSocialLinks(prev => ({ ...prev, [key]: e.target.value }))}
                      onBlur={e =>
                        setSocialLinks(prev => ({ ...prev, [key]: e.target.value.trim() }))
                      }
                      placeholder={t(placeholderKey)}
                      className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                        socialLinks[key] && !isValidUrl(socialLinks[key])
                          ? 'border-destructive/40'
                          : 'border-input'
                      }`}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{t(hintKey)}</p>
                  </div>
                ))}
              </div>

              {/* Redirect note — social platform URLs managed in Branding → Social */}
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
                <p className="text-sm text-foreground">{t('socialRedirectNote')}</p>
                <p className="mt-1.5 text-xs text-muted-foreground" dir="rtl">
                  {t('socialRedirectNote')}
                </p>
                <a
                  href={`/stores/${storeId}/branding`}
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  ↗ {t('socialRedirectNoteLinkText')}
                </a>
              </div>
            </div>
          </div>
        </details>
      </div>
      <StickySaveBar
        dirty={dirty || isSaving}
        onSave={handleSave}
        onReset={() => void fetchSeo()}
        saving={isSaving}
        saveLabel={t('saveChanges')}
      />
    </AdminLayout>
  );
}
