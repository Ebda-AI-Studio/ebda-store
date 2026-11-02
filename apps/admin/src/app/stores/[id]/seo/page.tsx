'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete, unwrapList, unwrapObject } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { ImageUpload } from '../../../../components/ImageUpload';

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

interface StoreFaq {
  id: string;
  question: string;
  questionAr: string | null;
  answer: string;
  answerAr: string | null;
  orderIndex: number;
  isActive: boolean;
}

interface HowtoStep {
  name: string;
  text: string;
  image?: string;
}

interface StoreHowto {
  id: string;
  title: string;
  titleAr: string | null;
  description: string;
  descriptionAr: string | null;
  steps: HowtoStep[];
  stepsAr: HowtoStep[] | null;
  orderIndex: number;
  isActive: boolean;
}

const EMPTY_FAQ: Omit<StoreFaq, 'id'> = {
  question: '',
  questionAr: null,
  answer: '',
  answerAr: null,
  orderIndex: 0,
  isActive: true,
};

const EMPTY_HOWTO: Omit<StoreHowto, 'id'> = {
  title: '',
  titleAr: null,
  description: '',
  descriptionAr: null,
  steps: [{ name: '', text: '' }],
  // Pre-align stepsAr with steps so the editor always has both halves
  // to render. Older rows (and rows from before bilingual editing was
  // wired) can have stepsAr = null; the load path normalizes those.
  stepsAr: [{ name: '', text: '' }],
  orderIndex: 0,
  isActive: true,
};

/**
 * Normalize a `stepsAr` array to match the length of `steps`. Older
 * HowTo rows can have `stepsAr = null` (single-language draft) or a
 * length mismatch (e.g. someone added a step in English without the
 * Arabic side existing yet). The editor renders one row per step
 * with EN and AR fields side-by-side, so the arrays MUST be the
 * same length while editing. The save path keeps `stepsAr = null`
 * possible by passing through this same shape — only the editor
 * cares about alignment.
 */
function alignStepsAr(steps: HowtoStep[], stepsAr: HowtoStep[] | null): HowtoStep[] {
  const ar = Array.isArray(stepsAr) ? stepsAr : [];
  if (ar.length === steps.length)
    return ar.map(s => ({ name: s?.name ?? '', text: s?.text ?? '' }));
  const out: HowtoStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const slot = ar[i];
    out.push({ name: slot?.name ?? '', text: slot?.text ?? '' });
  }
  return out;
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

  // FAQ state
  const [faqs, setFaqs] = useState<StoreFaq[]>([]);
  const [editingFaqId, setEditingFaqId] = useState<string | 'new' | null>(null);
  const [faqDraft, setFaqDraft] = useState<Omit<StoreFaq, 'id'>>(EMPTY_FAQ);
  const [isSavingFaq, setIsSavingFaq] = useState(false);

  // HowTo state
  const [howtos, setHowtos] = useState<StoreHowto[]>([]);
  const [editingHowtoId, setEditingHowtoId] = useState<string | 'new' | null>(null);
  const [howtoDraft, setHowtoDraft] = useState<Omit<StoreHowto, 'id'>>(EMPTY_HOWTO);
  const [isSavingHowto, setIsSavingHowto] = useState(false);

  // Social & Knowledge Graph state
  const [socialLinks, setSocialLinks] = useState<SocialLinks>(DEFAULT_SOCIAL);
  const [isSavingSocial, setIsSavingSocial] = useState(false);
  const [socialMessage, setSocialMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const fetchSeo = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const [seoRes, faqsRes, howtosRes, storeRes] = await Promise.all([
        apiGet<{ seo?: Partial<SeoSettings> }>(`/api/v1/stores/${storeId}/seo`),
        apiGet<StoreFaq[]>(`/api/v1/stores/${storeId}/faqs`),
        apiGet<StoreHowto[]>(`/api/v1/stores/${storeId}/howtos`),
        apiGet<{ store?: { socialLinks?: Partial<SocialLinks> } }>(`/api/v1/stores/${storeId}`),
      ]);

      const seoData = seoRes.data;
      const seo: Partial<SeoSettings> | null =
        (seoData?.seo ?? (seoData as unknown as Partial<SeoSettings>)) || null;
      if (seo) {
        setSettings({
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
        });
      }

      if (faqsRes.data) {
        setFaqs(unwrapList<StoreFaq>(faqsRes.data));
      }
      if (howtosRes.data) {
        setHowtos(unwrapList<StoreHowto>(howtosRes.data));
      }

      const storeBody = unwrapObject<{
        store?: { socialLinks?: Record<string, string> };
        socialLinks?: Record<string, string>;
      }>(storeRes.data);
      const rawSocial: Record<string, string> =
        storeBody?.store?.socialLinks ?? storeBody?.socialLinks ?? {};
      setSocialLinks({
        wikidata: rawSocial.wikidata || '',
        wikipedia: rawSocial.wikipedia || '',
        instagram: rawSocial.instagram || '',
        tiktok: rawSocial.tiktok || '',
        linkedin: rawSocial.linkedin || '',
        facebook: rawSocial.facebook || '',
        youtube: rawSocial.youtube || '',
        twitter: rawSocial.twitter || '',
      });
    } catch (err) {
      console.error('Failed to fetch SEO settings:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  // --- FAQ handlers ---
  async function handleSaveFaq() {
    if (!storeId) return;
    setIsSavingFaq(true);
    try {
      if (editingFaqId === 'new') {
        const { data, error } = await apiPost<StoreFaq>(`/api/v1/stores/${storeId}/faqs`, faqDraft);
        if (error) throw new Error(error.message);
        const created = unwrapObject<StoreFaq>(data);
        if (created) setFaqs(prev => [...prev, created]);
      } else if (editingFaqId) {
        const { data, error } = await apiPut<StoreFaq>(
          `/api/v1/stores/${storeId}/faqs/${editingFaqId}`,
          faqDraft
        );
        if (error) throw new Error(error.message);
        const updated = unwrapObject<StoreFaq>(data);
        if (updated) setFaqs(prev => prev.map(f => (f.id === editingFaqId ? updated : f)));
      }
      setEditingFaqId(null);
      setFaqDraft(EMPTY_FAQ);
    } catch {
      setMessage({ type: 'error', text: t('faqSaveError') });
    } finally {
      setIsSavingFaq(false);
    }
  }

  async function handleDeleteFaq(faqId: string) {
    if (!storeId) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/faqs/${faqId}`);
      if (error) throw new Error(error.message);
      setFaqs(prev => prev.filter(f => f.id !== faqId));
    } catch {
      setMessage({ type: 'error', text: t('faqDeleteError') });
    }
  }

  async function handleToggleFaqActive(faq: StoreFaq) {
    if (!storeId) return;
    try {
      const { data, error } = await apiPut<StoreFaq>(`/api/v1/stores/${storeId}/faqs/${faq.id}`, {
        isActive: !faq.isActive,
      });
      if (error) throw new Error(error.message);
      const updated = unwrapObject<StoreFaq>(data);
      if (updated) setFaqs(prev => prev.map(f => (f.id === faq.id ? updated : f)));
    } catch {
      setMessage({ type: 'error', text: t('faqSaveError') });
    }
  }

  async function handleMoveFaq(faqId: string, direction: 'up' | 'down') {
    const idx = faqs.findIndex(f => f.id === faqId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= faqs.length) return;
    const reordered = [...faqs];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    const withIndex = reordered.map((f, i) => ({ ...f, orderIndex: i }));
    setFaqs(withIndex);
    // Persist updated order indices
    await Promise.all(
      withIndex.map(f =>
        apiPut(`/api/v1/stores/${storeId}/faqs/${f.id}`, { orderIndex: f.orderIndex })
      )
    );
  }

  // --- HowTo handlers ---
  async function handleSaveHowto() {
    if (!storeId) return;
    setIsSavingHowto(true);
    try {
      if (editingHowtoId === 'new') {
        const { data, error } = await apiPost<StoreHowto>(
          `/api/v1/stores/${storeId}/howtos`,
          howtoDraft
        );
        if (error) throw new Error(error.message);
        const created = unwrapObject<StoreHowto>(data);
        if (created) setHowtos(prev => [...prev, created]);
      } else if (editingHowtoId) {
        const { data, error } = await apiPut<StoreHowto>(
          `/api/v1/stores/${storeId}/howtos/${editingHowtoId}`,
          howtoDraft
        );
        if (error) throw new Error(error.message);
        const updated = unwrapObject<StoreHowto>(data);
        if (updated) setHowtos(prev => prev.map(h => (h.id === editingHowtoId ? updated : h)));
      }
      setEditingHowtoId(null);
      setHowtoDraft(EMPTY_HOWTO);
    } catch {
      setMessage({ type: 'error', text: t('howtoSaveError') });
    } finally {
      setIsSavingHowto(false);
    }
  }

  async function handleDeleteHowto(howtoId: string) {
    if (!storeId) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/howtos/${howtoId}`);
      if (error) throw new Error(error.message);
      setHowtos(prev => prev.filter(h => h.id !== howtoId));
    } catch {
      setMessage({ type: 'error', text: t('howtoDeleteError') });
    }
  }

  async function handleToggleHowtoActive(howto: StoreHowto) {
    if (!storeId) return;
    try {
      const { data, error } = await apiPut<StoreHowto>(
        `/api/v1/stores/${storeId}/howtos/${howto.id}`,
        { isActive: !howto.isActive }
      );
      if (error) throw new Error(error.message);
      const updated = unwrapObject<StoreHowto>(data);
      if (updated) setHowtos(prev => prev.map(h => (h.id === howto.id ? updated : h)));
    } catch {
      setMessage({ type: 'error', text: t('howtoSaveError') });
    }
  }

  useEffect(() => {
    fetchSeo();
  }, [fetchSeo]);

  async function handleSaveSocial() {
    setIsSavingSocial(true);
    setSocialMessage(null);
    try {
      // Only save knowledge-graph fields (wikidata + wikipedia) from this page.
      // Social platform URLs (instagram, facebook, tiktok, etc.) are managed
      // exclusively in Branding → Social to avoid duplicate-save conflicts.
      const knowledgeGraphKeys: (keyof SocialLinks)[] = ['wikidata', 'wikipedia'];
      const payload = Object.fromEntries(
        knowledgeGraphKeys
          .map(k => [k, socialLinks[k].trim()] as [string, string])
          .filter(([, v]) => v === '' || isValidUrl(v))
      );
      const { error } = await apiPut(`/api/v1/stores/${storeId}/social`, payload);
      if (error) {
        setSocialMessage({ type: 'error', text: error.message || t('socialSaveError') });
      } else {
        setSocialMessage({ type: 'success', text: t('socialSaveSuccess') });
      }
    } catch {
      setSocialMessage({ type: 'error', text: t('socialSaveError') });
    } finally {
      setIsSavingSocial(false);
    }
  }

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
          <Link href={`/stores/${storeId}/seo/redirects`}>
            <Button type="button" variant="outline">
              {t('manageRedirects')}
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => handleGenerate('fill-empty')}
            disabled={isGenerating || isSaving}
            className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            title={t('aiGenerateTooltip')}
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
            <span>{isGenerating ? t('generating') : t('generateWithAi')}</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-6 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
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
            <p className="text-lg font-medium text-info-ink leading-tight line-clamp-1">
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
              <span className="text-xs font-bold text-info-ink">{t('enBadge')}</span>
            </div>
            <h2 className="font-semibold text-foreground">{t('englishSeo')}</h2>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                data-setting-id="seo.meta-title"
                className="text-sm font-medium text-foreground"
              >
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
              onChange={e => setSettings(prev => ({ ...prev, metaDescriptionAeo: e.target.value }))}
              placeholder={t('aeoPlaceholderEn')}
              rows={3}
              maxLength={DESC_MAX + 50}
              className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none ${
                settings.metaDescriptionAeo.length > DESC_MAX
                  ? 'border-destructive/40'
                  : 'border-border'
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
                  setSettings(prev => ({
                    ...prev,
                    googleSiteVerification: extractGoogleVerificationToken(e.target.value),
                  }))
                }
                placeholder={t('googleSiteVerificationPlaceholder')}
                className="w-full rounded-lg border border-border px-4 py-2 text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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

        {/* ===== Frequently Asked Questions ===== */}
        <div id="faqs" className="scroll-mt-24 rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 data-setting-id="seo.faqs" className="font-semibold text-foreground">
                {t('faqsTitle')}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('faqsSubtitle')}</p>
            </div>
            {editingFaqId === null && (
              <button
                type="button"
                onClick={() => {
                  setFaqDraft({ ...EMPTY_FAQ, orderIndex: faqs.length });
                  setEditingFaqId('new');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary-ink hover:bg-primary/10"
              >
                + {t('addFaq')}
              </button>
            )}
          </div>

          {/* FAQ list */}
          {faqs.map((faq, idx) => (
            <div key={faq.id} className="rounded-lg border border-border p-4 space-y-3">
              {editingFaqId === faq.id ? (
                /* Inline edit form */
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqQuestion')}
                      </label>
                      <input
                        type="text"
                        value={faqDraft.question}
                        onChange={e => setFaqDraft(d => ({ ...d, question: e.target.value }))}
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqQuestionAr')}
                      </label>
                      <input
                        type="text"
                        lang="ar"
                        dir="rtl"
                        value={faqDraft.questionAr ?? ''}
                        onChange={e =>
                          setFaqDraft(d => ({ ...d, questionAr: e.target.value || null }))
                        }
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqAnswer')}
                      </label>
                      <textarea
                        rows={3}
                        value={faqDraft.answer}
                        onChange={e => setFaqDraft(d => ({ ...d, answer: e.target.value }))}
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqAnswerAr')}
                      </label>
                      <textarea
                        rows={3}
                        lang="ar"
                        dir="rtl"
                        value={faqDraft.answerAr ?? ''}
                        onChange={e =>
                          setFaqDraft(d => ({ ...d, answerAr: e.target.value || null }))
                        }
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isSavingFaq}
                      onClick={handleSaveFaq}
                      className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                    >
                      {isSavingFaq ? '…' : t('faqSave')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingFaqId(null);
                        setFaqDraft(EMPTY_FAQ);
                      }}
                      className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
                    >
                      {t('faqCancel')}
                    </button>
                  </div>
                </div>
              ) : (
                /* Read view */
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground line-clamp-1">
                      {faq.question}
                    </p>
                    {faq.questionAr && (
                      <p className="text-xs text-muted-foreground line-clamp-1" dir="rtl" lang="ar">
                        {faq.questionAr}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{faq.answer}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMoveFaq(faq.id, 'up')}
                      disabled={idx === 0}
                      title={t('faqMoveUp')}
                      className="rounded p-1 hover:bg-muted disabled:opacity-30 text-xs"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveFaq(faq.id, 'down')}
                      disabled={idx === faqs.length - 1}
                      title={t('faqMoveDown')}
                      className="rounded p-1 hover:bg-muted disabled:opacity-30 text-xs"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleFaqActive(faq)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${faq.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
                    >
                      {faq.isActive ? t('faqActive') : t('faqInactive')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFaqDraft({
                          question: faq.question,
                          questionAr: faq.questionAr,
                          answer: faq.answer,
                          answerAr: faq.answerAr,
                          orderIndex: faq.orderIndex,
                          isActive: faq.isActive,
                        });
                        setEditingFaqId(faq.id);
                      }}
                      className="rounded p-1.5 hover:bg-muted text-xs border border-border"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteFaq(faq.id)}
                      className="rounded p-1.5 hover:bg-destructive/10 text-destructive-ink text-xs border border-border"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* New FAQ form */}
          {editingFaqId === 'new' && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqQuestion')}
                  </label>
                  <input
                    type="text"
                    value={faqDraft.question}
                    onChange={e => setFaqDraft(d => ({ ...d, question: e.target.value }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqQuestionAr')}
                  </label>
                  <input
                    type="text"
                    lang="ar"
                    dir="rtl"
                    value={faqDraft.questionAr ?? ''}
                    onChange={e => setFaqDraft(d => ({ ...d, questionAr: e.target.value || null }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqAnswer')}
                  </label>
                  <textarea
                    rows={3}
                    value={faqDraft.answer}
                    onChange={e => setFaqDraft(d => ({ ...d, answer: e.target.value }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqAnswerAr')}
                  </label>
                  <textarea
                    rows={3}
                    lang="ar"
                    dir="rtl"
                    value={faqDraft.answerAr ?? ''}
                    onChange={e => setFaqDraft(d => ({ ...d, answerAr: e.target.value || null }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isSavingFaq || !faqDraft.question || !faqDraft.answer}
                  onClick={handleSaveFaq}
                  className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSavingFaq ? '…' : t('faqSave')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingFaqId(null);
                    setFaqDraft(EMPTY_FAQ);
                  }}
                  className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
                >
                  {t('faqCancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ===== How-To Guides ===== */}
        <div id="howtos" className="scroll-mt-24 rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 data-setting-id="seo.how-tos" className="font-semibold text-foreground">
                {t('howtosTitle')}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('howtosSubtitle')}</p>
            </div>
            {editingHowtoId === null && (
              <button
                type="button"
                onClick={() => {
                  setHowtoDraft({ ...EMPTY_HOWTO, orderIndex: howtos.length });
                  setEditingHowtoId('new');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary-ink hover:bg-primary/10"
              >
                + {t('addHowto')}
              </button>
            )}
          </div>

          {/* HowTo list */}
          {howtos.map(howto => (
            <div key={howto.id} className="rounded-lg border border-border p-4 space-y-3">
              {editingHowtoId === howto.id ? (
                /* Inline edit form */
                <HowtoForm
                  draft={howtoDraft}
                  setDraft={setHowtoDraft}
                  t={t}
                  isSaving={isSavingHowto}
                  onSave={handleSaveHowto}
                  onCancel={() => {
                    setEditingHowtoId(null);
                    setHowtoDraft(EMPTY_HOWTO);
                  }}
                />
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground line-clamp-1">
                      {howto.title}
                    </p>
                    {howto.titleAr && (
                      <p className="text-xs text-muted-foreground line-clamp-1" dir="rtl" lang="ar">
                        {howto.titleAr}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('stepsCount', { count: howto.steps.length })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleHowtoActive(howto)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${howto.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
                    >
                      {howto.isActive ? t('howtoActive') : t('howtoInactive')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHowtoDraft({
                          title: howto.title,
                          titleAr: howto.titleAr,
                          description: howto.description,
                          descriptionAr: howto.descriptionAr,
                          steps: howto.steps,
                          // Align AR steps to EN steps length so the editor
                          // always has both halves to render even when the
                          // row originated from a single-language source.
                          stepsAr: alignStepsAr(howto.steps, howto.stepsAr),
                          orderIndex: howto.orderIndex,
                          isActive: howto.isActive,
                        });
                        setEditingHowtoId(howto.id);
                      }}
                      className="rounded p-1.5 hover:bg-muted text-xs border border-border"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteHowto(howto.id)}
                      className="rounded p-1.5 hover:bg-destructive/10 text-destructive-ink text-xs border border-border"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* New HowTo form */}
          {editingHowtoId === 'new' && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <HowtoForm
                draft={howtoDraft}
                setDraft={setHowtoDraft}
                t={t}
                isSaving={isSavingHowto}
                onSave={handleSaveHowto}
                onCancel={() => {
                  setEditingHowtoId(null);
                  setHowtoDraft(EMPTY_HOWTO);
                }}
                autoFocus
              />
            </div>
          )}
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
            <button
              type="button"
              onClick={handleSaveSocial}
              disabled={isSavingSocial}
              className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {isSavingSocial ? '…' : t('faqSave')}
            </button>
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
                  onBlur={e => setSocialLinks(prev => ({ ...prev, [key]: e.target.value.trim() }))}
                  placeholder={t(placeholderKey)}
                  className={`w-full rounded-lg border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
                    socialLinks[key] && !isValidUrl(socialLinks[key])
                      ? 'border-destructive/40'
                      : 'border-border'
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

          {socialMessage && (
            <div
              className={`rounded-lg p-3 text-sm ${
                socialMessage.type === 'success'
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                  : 'bg-destructive/5 border border-destructive/30 text-destructive-ink'
              }`}
            >
              {socialMessage.text}
            </div>
          )}
        </div>

        {/* Save message */}
        {message && (
          <div
            className={`rounded-xl p-4 text-sm ${
              message.type === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-destructive/5 border border-destructive/30 text-destructive-ink'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

// ===== HowtoForm sub-component =====

interface HowtoFormProps {
  draft: Omit<StoreHowto, 'id'>;
  setDraft: React.Dispatch<React.SetStateAction<Omit<StoreHowto, 'id'>>>;
  t: (key: string) => string;
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

function HowtoForm({ draft, setDraft, t, isSaving, onSave, onCancel, autoFocus }: HowtoFormProps) {
  const canSave =
    draft.title.trim() !== '' &&
    draft.description.trim() !== '' &&
    draft.steps.length > 0 &&
    draft.steps.every(s => s.name.trim() !== '' && s.text.trim() !== '');

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoGuideTitle')}
          </label>
          <input
            type="text"
            value={draft.title}
            autoFocus={autoFocus}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoGuideTitleAr')}
          </label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={draft.titleAr ?? ''}
            onChange={e => setDraft(d => ({ ...d, titleAr: e.target.value || null }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoDescription')}
          </label>
          <textarea
            rows={2}
            value={draft.description}
            onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoDescriptionAr')}
          </label>
          <textarea
            rows={2}
            lang="ar"
            dir="rtl"
            value={draft.descriptionAr ?? ''}
            onChange={e => setDraft(d => ({ ...d, descriptionAr: e.target.value || null }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
      </div>

      {/* Steps — each step has EN + AR side-by-side. The arrays
          `steps` and `stepsAr` are kept aligned 1:1 so add/remove
          always touches both. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-foreground">{t('howtoSteps')}</label>
          <button
            type="button"
            onClick={() =>
              setDraft(d => ({
                ...d,
                steps: [...d.steps, { name: '', text: '' }],
                stepsAr: [...(d.stepsAr ?? []), { name: '', text: '' }],
              }))
            }
            className="text-xs text-primary hover:underline"
          >
            + {t('addStep')}
          </button>
        </div>
        {draft.steps.map((step, i) => {
          const stepAr = draft.stepsAr?.[i] ?? { name: '', text: '' };
          return (
            <div key={i} className="mb-2 rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary-ink">
                  {i + 1}
                </span>
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder={t('stepName')}
                    value={step.name}
                    onChange={e =>
                      setDraft(d => {
                        const steps = [...d.steps];
                        steps[i] = { ...steps[i], name: e.target.value };
                        return { ...d, steps };
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    type="text"
                    lang="ar"
                    dir="rtl"
                    placeholder={t('stepNameAr')}
                    value={stepAr.name}
                    onChange={e =>
                      setDraft(d => {
                        const stepsAr = [...(d.stepsAr ?? [])];
                        while (stepsAr.length <= i) stepsAr.push({ name: '', text: '' });
                        stepsAr[i] = { ...stepsAr[i], name: e.target.value };
                        return { ...d, stepsAr };
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                {draft.steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft(d => ({
                        ...d,
                        steps: d.steps.filter((_, idx) => idx !== i),
                        stepsAr: (d.stepsAr ?? []).filter((_, idx) => idx !== i),
                      }))
                    }
                    className="text-destructive-ink hover:text-destructive-ink/80 text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <textarea
                  rows={2}
                  placeholder={t('stepInstruction')}
                  value={step.text}
                  onChange={e =>
                    setDraft(d => {
                      const steps = [...d.steps];
                      steps[i] = { ...steps[i], text: e.target.value };
                      return { ...d, steps };
                    })
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <textarea
                  rows={2}
                  lang="ar"
                  dir="rtl"
                  placeholder={t('stepInstructionAr')}
                  value={stepAr.text}
                  onChange={e =>
                    setDraft(d => {
                      const stepsAr = [...(d.stepsAr ?? [])];
                      while (stepsAr.length <= i) stepsAr.push({ name: '', text: '' });
                      stepsAr[i] = { ...stepsAr[i], text: e.target.value };
                      return { ...d, stepsAr };
                    })
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isSaving || !canSave}
          onClick={onSave}
          className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {isSaving ? '…' : t('howtoSave')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
        >
          {t('howtoCancel')}
        </button>
      </div>
    </div>
  );
}
