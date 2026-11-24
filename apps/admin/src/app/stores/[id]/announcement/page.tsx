'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
// NOTE (2026-06-09 overlap audit #4/#5): announcement-bar VISIBILITY (`enabled`)
// and BACKGROUND color (`bgColor`) are now owned by the visual editor
// (layout.announcement.*), which wins at render (ShopChrome resolves
// `layout.announcement.enabled ?? announcementBar.enabled` and the same for
// bgColor). This page is now content-only: it edits text/link/textColor and
// no longer sends `enabled`/`bgColor`, so the two surfaces can't diverge.
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { ColorField } from '../../../../components/ColorField';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import type { StoreTheme } from '@ebda/shared';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// Field names mirror the canonical AnnouncementBar shape from @ebda/shared
// and the API's announcementSchema (`bgColor`, `link`). The previous local
// names (`backgroundColor`, `linkUrl`) were silently dropped by Zod's
// .strip() so the bg color and link never reached the DB.
interface AnnouncementSettings {
  enabled: boolean;
  text: string;
  textAr: string;
  bgColor: string;
  textColor: string;
  link: string;
  linkText: string;
  linkTextAr: string;
  dismissible: boolean;
}

const DEFAULT_SETTINGS: AnnouncementSettings = {
  enabled: false,
  text: '',
  textAr: '',
  bgColor: '#000000',
  textColor: '#ffffff',
  link: '',
  linkText: '',
  linkTextAr: '',
  dismissible: false,
};

export default function AnnouncementPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('announcement.page');

  const [settings, setSettings] = useState<AnnouncementSettings>(DEFAULT_SETTINGS);
  // Store theme is loaded in parallel with the announcement settings so the
  // ColorField can offer brand-token options for the text color picker.
  const [storeTheme, setStoreTheme] = useState<StoreTheme | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();
  const [baseline, setBaseline] = useState<string | null>(null);

  const fetchAnnouncement = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const [announcementRes, storeRes] = await Promise.all([
        apiGet<{ announcement?: AnnouncementSettings } | AnnouncementSettings>(
          `/api/v1/stores/${storeId}/announcement`
        ),
        apiGet<{ store?: { theme?: StoreTheme } }>(`/api/v1/stores/${storeId}`),
      ]);
      const announcement =
        (announcementRes.data && 'announcement' in announcementRes.data
          ? announcementRes.data.announcement
          : announcementRes.data) || null;
      const loaded = announcement ? { ...DEFAULT_SETTINGS, ...announcement } : DEFAULT_SETTINGS;
      setSettings(loaded);
      setBaseline(JSON.stringify(loaded));
      if (storeRes.data?.store?.theme) {
        setStoreTheme(storeRes.data.store.theme);
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
    try {
      // Send content only. `enabled` + `bgColor` are owned by the visual editor
      // (layout.announcement.*) and intentionally omitted — the API merges, so
      // omitting them preserves any legacy values without this page clobbering
      // the editor-managed chrome.
      const { enabled: _enabled, bgColor: _bgColor, ...content } = settings;
      void _enabled;
      void _bgColor;
      const { error } = await apiPut(`/api/v1/stores/${storeId}/announcement`, content);

      if (!error) {
        setBaseline(JSON.stringify(settings));
        toastSuccess(t('successMessage'), '');
      } else {
        toastError(t('failedMessage'), error.message || '');
      }
    } catch {
      toastError(t('connectionError'), '');
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')}>
        <div className="animate-pulse space-y-4" aria-busy="true">
          <div className="h-20 rounded-md bg-muted" />
          <div className="h-64 rounded-md bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {/* Live Preview */}
      {settings.text && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('preview')}
          </p>
          {/* Preview uses a neutral surface — the live background color is set
              in the visual editor (announcement section). */}
          <div
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-foreground"
            style={{
              color: settings.textColor,
            }}
          >
            <span>{settings.text}</span>
            {settings.link && settings.linkText && (
              <span className="underline">{settings.linkText}</span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6 pb-24">
        {/* Content */}
        <div className="rounded-md border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">{t('content')}</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('textEnglish')}
              </label>
              <input
                type="text"
                value={settings.text}
                onChange={e => setSettings(prev => ({ ...prev, text: e.target.value }))}
                placeholder={t('textEnglishPlaceholder')}
                className={FIELD_CLASSES}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('textArabic')}
              </label>
              <input
                type="text"
                lang="ar"
                dir="rtl"
                value={settings.textAr}
                onChange={e => setSettings(prev => ({ ...prev, textAr: e.target.value }))}
                placeholder={t('textArabicPlaceholder')}
                className={FIELD_CLASSES}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('linkUrl')}</label>
            <input
              type="url"
              value={settings.link}
              onChange={e => setSettings(prev => ({ ...prev, link: e.target.value }))}
              placeholder={t('linkUrlPlaceholder')}
              className={FIELD_CLASSES}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('linkUrlHint')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('linkTextEnglish')}
              </label>
              <input
                type="text"
                value={settings.linkText}
                onChange={e => setSettings(prev => ({ ...prev, linkText: e.target.value }))}
                placeholder={t('linkTextEnglishPlaceholder')}
                className={FIELD_CLASSES}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                {t('linkTextArabic')}
              </label>
              <input
                type="text"
                lang="ar"
                dir="rtl"
                value={settings.linkTextAr}
                onChange={e => setSettings(prev => ({ ...prev, linkTextAr: e.target.value }))}
                placeholder={t('linkTextArabicPlaceholder')}
                className={FIELD_CLASSES}
              />
            </div>
          </div>
        </div>

        {/* Text color. The background color is set in the visual editor
            (announcement section) — see the pointer above. */}
        <div className="rounded-md border bg-card p-6 shadow-sm space-y-4">
          <h2 className="font-semibold text-foreground">{t('colors')}</h2>

          <div className="grid gap-6 sm:grid-cols-2">
            <ColorField
              label={t('textColor')}
              value={settings.textColor}
              onChange={v => setSettings(prev => ({ ...prev, textColor: v }))}
              theme={storeTheme}
              showContrastPreview={false}
            />
          </div>
        </div>
      </div>
      <StickySaveBar
        dirty={baseline !== null && JSON.stringify(settings) !== baseline}
        onSave={handleSave}
        onReset={() => baseline && setSettings(JSON.parse(baseline))}
        saving={isSaving}
        saveLabel={t('saveChanges')}
      />
    </AdminLayout>
  );
}
