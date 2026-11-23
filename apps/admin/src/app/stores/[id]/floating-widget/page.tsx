'use client';

import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { apiGet, apiPut } from '../../../../lib/api';
import { ColorField } from '../../../../components/ColorField';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useT } from '@/i18n/useT';
import type {
  FloatingButton,
  FloatingButtonKind,
  FloatingExpandDirection,
  FloatingPosition,
  FloatingWidgetConfig,
  StoreTheme,
} from '@ebda/shared';
import { DEFAULT_FLOATING_WIDGET_CONFIG } from '@ebda/shared';

interface StoreSocialLinks {
  instagram?: string;
  twitter?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  snapchat?: string;
  linkedin?: string;
  whatsapp?: string;
  telegram?: string;
  pinterest?: string;
}

interface StoreInfo {
  id: string;
  name: string;
  theme?: StoreTheme;
  settings?: Record<string, unknown>;
  enabledFeatures?: string[];
  /** Store-level WhatsApp number (store.whatsapp column). */
  whatsapp?: string;
  /** Store-level phone number. */
  phone?: string;
  /** Store-level social links (socialLinks column). */
  socialLinks?: StoreSocialLinks;
}

// Kind labels are translated via t(`kind.${k}`) at the select below (was a
// static {en,ar} map — next-intl now picks the admin's own locale).
const ALL_BUTTON_KINDS: FloatingButtonKind[] = [
  'whatsapp',
  'instagram',
  'phone',
  'email',
  'music',
  'custom',
  'tiktok',
  'snapchat',
  'youtube',
  'facebook',
  'x',
  'telegram',
];

// Translated via t(`position.${k}`) at the select below.
const ALL_POSITIONS: FloatingPosition[] = ['br', 'bl', 'tr', 'tl'];

// Translated via t(`expand.${k}`) at the select below.
const ALL_EXPAND_DIRECTIONS: FloatingExpandDirection[] = ['up', 'down', 'left', 'right'];

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function FloatingWidgetPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { success: toastSuccess, error: toastError } = useToast();
  // useFeatures hooks into the AdminFeatureProvider which fetches the
  // canonical /api/v1/admin/stores/:id/features endpoint. The admin
  // store endpoint doesn't include enabledFeatures, so checking
  // store.enabledFeatures directly was always falsy. Verified
  // 2026-05-21 — ahmad enabled floating_widget but the page kept
  // showing 'Feature not enabled' until this hook was used.
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const t = useT('floatingWidget');

  const [store, setStore] = useState<StoreInfo | null>(null);
  const [config, setConfig] = useState<FloatingWidgetConfig>(DEFAULT_FLOATING_WIDGET_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // The config as last loaded/saved: the sticky bar shows while the form differs from it.
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`)
      .then(res => {
        if (res.data?.store) {
          setStore(res.data.store);
          const existing = res.data.store.settings?.floatingWidget as
            | FloatingWidgetConfig
            | undefined;
          const loaded = { ...DEFAULT_FLOATING_WIDGET_CONFIG, ...(existing ?? {}) };
          setConfig(loaded);
          setBaseline(JSON.stringify(loaded));
        }
      })
      .finally(() => setLoading(false));
  }, [storeId]);

  const featureEnabled = isEnabled('floating_widget');

  const handleSave = useCallback(async () => {
    if (!store) return;
    setSaving(true);
    // 2026-05-21 v2 — dedicated /floating-widget endpoint. Previous fix
    // (round-tripping the whole settings JSON via PUT /stores/:id) was
    // correct in theory but fragile: stale local copies of `store.settings`
    // racing with the bulk-ai AEO sweep's settings writes could clobber
    // fields. The new endpoint accepts ONLY the widget config and merges
    // server-side, same pattern as announcement/branding/seo/contact.
    const res = await apiPut(`/api/v1/stores/${storeId}/floating-widget`, config);
    setSaving(false);
    if (res.error) {
      toastError(res.error.message || t('saveFailedFallback'));
    } else {
      setBaseline(JSON.stringify(config));
      toastSuccess(t('savedToast'));
    }
  }, [store, storeId, config, toastSuccess, toastError, t]);

  const patch = (next: Partial<FloatingWidgetConfig>) => setConfig(prev => ({ ...prev, ...next }));

  const addButton = () => {
    setConfig(prev => ({
      ...prev,
      buttons: [...(prev.buttons ?? []), { id: genId(), kind: 'whatsapp' }],
    }));
  };
  const updateButton = (id: string, next: Partial<FloatingButton>) => {
    setConfig(prev => ({
      ...prev,
      buttons: (prev.buttons ?? []).map(b => (b.id === id ? { ...b, ...next } : b)),
    }));
  };
  const removeButton = (id: string) => {
    setConfig(prev => ({
      ...prev,
      buttons: (prev.buttons ?? []).filter(b => b.id !== id),
    }));
  };
  const moveButton = (id: string, delta: -1 | 1) => {
    setConfig(prev => {
      const buttons = [...(prev.buttons ?? [])];
      const idx = buttons.findIndex(b => b.id === id);
      const targetIdx = idx + delta;
      if (idx < 0 || targetIdx < 0 || targetIdx >= buttons.length) return prev;
      [buttons[idx], buttons[targetIdx]] = [buttons[targetIdx], buttons[idx]];
      return { ...prev, buttons };
    });
  };

  if (loading || featuresLoading) {
    return (
      <AdminLayout title={t('pageTitle')}>
        <div className="animate-pulse space-y-4">
          <div className="h-24 rounded-2xl bg-muted" />
          <div className="h-48 rounded-2xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  if (!featureEnabled) {
    return (
      <AdminLayout title={t('pageTitle')} subtitle={t('premiumSubtitle')}>
        <div className="max-w-xl rounded-2xl border border-border bg-card p-8 text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            {t('featureNotEnabledTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('featureNotEnabledBody')}</p>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('pageTitle')} subtitle={t('mainSubtitle')}>
      <div className="space-y-6 pb-32">
        {/* Master enable */}
        <section className="rounded-2xl border border-border bg-card p-6">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="flex-1 min-w-0">
              <span
                data-setting-id="floating-widget.show"
                className="block text-sm font-semibold text-foreground"
              >
                {t('showWidgetLabel')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('showWidgetHint')}
              </span>
            </span>
            <input
              type="checkbox"
              checked={config.enabled === true}
              onChange={e => patch({ enabled: e.target.checked })}
              className="h-5 w-5 cursor-pointer accent-primary"
            />
          </label>
        </section>

        {/* Position + expand direction */}
        <section className="grid gap-4 rounded-2xl border border-border bg-card p-6 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span
              data-setting-id="floating-widget.position"
              className="text-xs font-medium text-muted-foreground"
            >
              {t('positionLabel')}
            </span>
            <select
              value={config.position ?? 'br'}
              onChange={e => patch({ position: e.target.value as FloatingPosition })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              {ALL_POSITIONS.map(k => (
                <option key={k} value={k}>
                  {t(`position.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span
              data-setting-id="floating-widget.expand"
              className="text-xs font-medium text-muted-foreground"
            >
              {t('expandDirectionLabel')}
            </span>
            <select
              value={config.expandDirection ?? 'up'}
              onChange={e => patch({ expandDirection: e.target.value as FloatingExpandDirection })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
            >
              {ALL_EXPAND_DIRECTIONS.map(k => (
                <option key={k} value={k}>
                  {t(`expand.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.startExpanded === true}
              onChange={e => patch({ startExpanded: e.target.checked })}
              className="h-4 w-4 cursor-pointer accent-primary"
            />
            <span className="text-sm text-foreground">{t('startExpandedLabel')}</span>
          </label>
          <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.hideOnMobile === true}
                onChange={e => patch({ hideOnMobile: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              {t('hideOnMobile')}
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.hideOnDesktop === true}
                onChange={e => patch({ hideOnDesktop: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              {t('hideOnDesktop')}
            </label>
          </div>
        </section>

        {/* Toggle button styling */}
        <section className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <header>
            <h2 className="text-base font-semibold text-foreground">{t('toggleButtonTitle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('toggleButtonHint')}</p>
          </header>
          <ColorField
            label={t('backgroundColorLabel')}
            value={config.toggleBgColor}
            onChange={v => patch({ toggleBgColor: v || undefined })}
            theme={store?.theme}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('tooltipEnLabel')}
              </span>
              <input
                type="text"
                value={config.toggleLabel ?? ''}
                onChange={e => patch({ toggleLabel: e.target.value })}
                placeholder={t('menuLabelEnSample')}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('tooltipArLabel')}
              </span>
              <input
                type="text"
                value={config.toggleLabelAr ?? ''}
                onChange={e => patch({ toggleLabelAr: e.target.value })}
                placeholder={t('menuLabelArSample')}
                dir="rtl"
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('customIconUrlLabel')}
            </span>
            <input
              type="url"
              value={config.toggleIconUrl ?? ''}
              onChange={e => patch({ toggleIconUrl: e.target.value })}
              placeholder="https://…/icon.png"
              className="h-5 w-9 cursor-pointer accent-primary"
            />
          </label>
        </section>

        {/* Buttons list */}
        <section className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <header className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-foreground">{t('buttonsTitle')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('buttonsHint')}</p>
            </div>
            <Button variant="outline" size="sm" type="button" onClick={addButton}>
              {t('addButton')}
            </Button>
          </header>
          {(config.buttons ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noButtonsHint')}</p>
          ) : (
            <ul className="space-y-3">
              {(config.buttons ?? []).map((b, i, arr) => (
                <li key={b.id} className="rounded-xl border border-border bg-background p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col gap-1 pt-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        onClick={() => moveButton(b.id, -1)}
                        disabled={i === 0}
                        className="text-muted-foreground"
                        aria-label={t('moveUp')}
                      >
                        ▲
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        onClick={() => moveButton(b.id, 1)}
                        disabled={i === arr.length - 1}
                        className="text-muted-foreground"
                        aria-label={t('moveDown')}
                      >
                        ▼
                      </Button>
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('kindLabel')}
                          </span>
                          <select
                            value={b.kind}
                            onChange={e =>
                              updateButton(b.id, { kind: e.target.value as FloatingButtonKind })
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          >
                            {ALL_BUTTON_KINDS.map(k => (
                              <option key={k} value={k}>
                                {t(`kind.${k}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="grid gap-2 md:grid-cols-2">
                          <input
                            type="text"
                            value={b.label ?? ''}
                            onChange={e => updateButton(b.id, { label: e.target.value })}
                            placeholder={t('tooltipEnPlaceholder')}
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            value={b.labelAr ?? ''}
                            onChange={e => updateButton(b.id, { labelAr: e.target.value })}
                            placeholder={t('tooltipArPlaceholder')}
                            dir="rtl"
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      </div>

                      {/* Kind-specific config */}
                      {b.kind === 'whatsapp' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('whatsappPhoneLabel')}
                            </span>
                            <input
                              type="tel"
                              inputMode="tel"
                              autoComplete="tel"
                              value={b.whatsappPhone ?? ''}
                              onChange={e => updateButton(b.id, { whatsappPhone: e.target.value })}
                              placeholder={
                                store?.whatsapp
                                  ? t('usingStoreWhatsapp', { value: store.whatsapp })
                                  : '201001234567'
                              }
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('whatsappMessageLabel')}
                            </span>
                            <input
                              type="text"
                              value={b.whatsappMessage ?? ''}
                              onChange={e =>
                                updateButton(b.id, { whatsappMessage: e.target.value })
                              }
                              placeholder={t('prefillExample')}
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}
                      {b.kind === 'instagram' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('instagramHandleLabel')}
                          </span>
                          <input
                            type="text"
                            value={b.instagramHandle ?? ''}
                            onChange={e => updateButton(b.id, { instagramHandle: e.target.value })}
                            placeholder={
                              store?.socialLinks?.instagram
                                ? t('usingStoreInstagram', { value: store.socialLinks.instagram })
                                : t('handleSampleDemoShop')
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'phone' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('phoneNumberLabel')}
                          </span>
                          <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            value={b.phoneNumber ?? ''}
                            onChange={e => updateButton(b.id, { phoneNumber: e.target.value })}
                            placeholder={
                              store?.phone
                                ? t('usingStorePhone', { value: store.phone })
                                : '+201001234567'
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'tiktok' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('tiktokHandleLabel')}
                          </span>
                          <input
                            type="text"
                            value={b.tiktokHandle ?? ''}
                            onChange={e => updateButton(b.id, { tiktokHandle: e.target.value })}
                            placeholder={
                              store?.socialLinks?.tiktok
                                ? t('usingStoreTiktok', { value: store.socialLinks.tiktok })
                                : t('handleSample')
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'snapchat' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('snapchatHandleLabel')}
                          </span>
                          <input
                            type="text"
                            value={b.snapchatHandle ?? ''}
                            onChange={e => updateButton(b.id, { snapchatHandle: e.target.value })}
                            placeholder={
                              store?.socialLinks?.snapchat
                                ? t('usingStoreSnapchat', { value: store.socialLinks.snapchat })
                                : t('handleSample')
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'youtube' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('youtubeUrlLabel')}
                          </span>
                          <input
                            type="url"
                            value={b.youtubeUrl ?? ''}
                            onChange={e => updateButton(b.id, { youtubeUrl: e.target.value })}
                            placeholder={
                              store?.socialLinks?.youtube
                                ? t('usingStoreYoutube', { value: store.socialLinks.youtube })
                                : 'https://youtube.com/@mystore'
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'facebook' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('facebookUrlLabel')}
                          </span>
                          <input
                            type="url"
                            value={b.facebookUrl ?? ''}
                            onChange={e => updateButton(b.id, { facebookUrl: e.target.value })}
                            placeholder={
                              store?.socialLinks?.facebook
                                ? t('usingStoreFacebook', { value: store.socialLinks.facebook })
                                : 'https://facebook.com/mystore'
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'x' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('xHandleLabel')}
                          </span>
                          <input
                            type="text"
                            value={b.xHandle ?? ''}
                            onChange={e => updateButton(b.id, { xHandle: e.target.value })}
                            placeholder={
                              store?.socialLinks?.twitter
                                ? t('usingStoreX', { value: store.socialLinks.twitter })
                                : t('handleSample')
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'telegram' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            {t('telegramHandleLabel')}
                          </span>
                          <input
                            type="text"
                            value={b.telegramHandle ?? ''}
                            onChange={e => updateButton(b.id, { telegramHandle: e.target.value })}
                            placeholder={
                              store?.socialLinks?.telegram
                                ? t('usingStoreTelegram', { value: store.socialLinks.telegram })
                                : t('handleSample')
                            }
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'email' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('emailAddressLabel')}
                            </span>
                            <input
                              type="email"
                              value={b.emailAddress ?? ''}
                              onChange={e => updateButton(b.id, { emailAddress: e.target.value })}
                              placeholder="info@store.com"
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('emailSubjectLabel')}
                            </span>
                            <input
                              type="text"
                              value={b.emailSubject ?? ''}
                              onChange={e => updateButton(b.id, { emailSubject: e.target.value })}
                              placeholder={t('emailSubjectExample')}
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}
                      {b.kind === 'music' && (
                        <div className="space-y-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('audioUrlLabel')}
                            </span>
                            <input
                              type="url"
                              value={b.musicUrl ?? ''}
                              onChange={e => updateButton(b.id, { musicUrl: e.target.value })}
                              placeholder="https://r2.dev/.../track.mp3"
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={b.musicLoop !== false}
                              onChange={e => updateButton(b.id, { musicLoop: e.target.checked })}
                              className="h-4 w-4 cursor-pointer accent-primary"
                            />
                            {t('loopAudioLabel')}
                          </label>
                        </div>
                      )}
                      {b.kind === 'custom' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('targetUrlLabel')}
                            </span>
                            <input
                              type="url"
                              value={b.customHref ?? ''}
                              onChange={e => updateButton(b.id, { customHref: e.target.value })}
                              placeholder="https://…"
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('iconUrlLabel')}
                            </span>
                            <input
                              type="url"
                              value={b.iconUrl ?? ''}
                              onChange={e => updateButton(b.id, { iconUrl: e.target.value })}
                              placeholder="https://…/icon.svg"
                              className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}

                      <div className="grid gap-3 md:grid-cols-2">
                        <ColorField
                          label={t('buttonBackgroundColorLabel')}
                          value={b.bgColor}
                          onChange={v => updateButton(b.id, { bgColor: v || undefined })}
                          theme={store?.theme}
                        />
                        <ColorField
                          label={t('iconColorLabel')}
                          value={b.iconColor}
                          onChange={v => updateButton(b.id, { iconColor: v || undefined })}
                          theme={store?.theme}
                        />
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      onClick={() => removeButton(b.id)}
                      className="text-destructive-ink"
                      aria-label={t('removeButtonAria')}
                    >
                      ✕
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <StickySaveBar
        dirty={baseline !== null && JSON.stringify(config) !== baseline}
        onSave={handleSave}
        onReset={() => baseline && setConfig(JSON.parse(baseline))}
        saving={saving}
        saveLabel={t('saveChanges')}
      />
    </AdminLayout>
  );
}
