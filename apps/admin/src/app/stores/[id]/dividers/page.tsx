'use client';

import { useEffect, useState, use } from 'react';
import { apiGet, apiPut } from '../../../../lib/api';
import {
  DEFAULT_DIVIDER_SETTINGS,
  type DividerSettings,
  type DividerStyle,
  type DividerThickness,
  type DividerWidth,
  type DividerColorMode,
  type DividerSpacing,
  type StoreTheme,
} from '@force/shared';
import { useT } from '@/i18n/useT';

interface StoreResponse {
  id: string;
  theme?: Partial<StoreTheme>;
}

/**
 * Bucket E (2026-05-17 evening) — dedicated section-divider admin page.
 * Lives at its own URL (/stores/[id]/dividers) because dividers are a
 * separator concept, not a font/color — Ahmad's directive to "make an
 * admin UI just for dividers". Typography page stays for fonts.
 *
 * Settings persist via PUT /stores/:id/theme (themeSchema is z.record
 * so the new `dividers` JSON field passes through with no API change).
 * Live preview pane re-renders on every form change so the merchant
 * sees exactly what the line will look like before saving.
 */
export default function DividersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: storeId } = use(params);
  const t = useT('dividers');

  const [settings, setSettings] = useState<DividerSettings>(DEFAULT_DIVIDER_SETTINGS);
  const [theme, setTheme] = useState<Partial<StoreTheme>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await apiGet<{ store: StoreResponse }>(`/api/v1/stores/${storeId}`);
      if (cancelled) return;
      const t = data?.store?.theme ?? {};
      setTheme(t);
      setSettings({ ...DEFAULT_DIVIDER_SETTINGS, ...(t.dividers ?? {}) });
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  function patch<K extends keyof DividerSettings>(key: K, value: DividerSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaveMsg(null);
  }

  async function handleSave() {
    setIsSaving(true);
    setSaveMsg(null);
    const nextTheme = { ...theme, dividers: settings };
    const { error } = await apiPut(`/api/v1/stores/${storeId}/theme`, nextTheme);
    setIsSaving(false);
    setSaveMsg(error ? error.message : t('saved'));
    if (!error) setTheme(nextTheme);
  }

  function reset() {
    setSettings(DEFAULT_DIVIDER_SETTINGS);
    setSaveMsg(null);
  }

  if (isLoading) {
    return <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('description')}</p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {/* Master toggle */}
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-foreground">
                {t('enabled.title')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('enabled.hint')}
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={e => patch('enabled', e.target.checked)}
              className="h-5 w-5 cursor-pointer accent-primary"
            />
          </label>

          {/* All other controls disabled when master off */}
          <fieldset
            disabled={!settings.enabled}
            className={`space-y-4 ${settings.enabled ? '' : 'opacity-50 pointer-events-none'}`}
          >
            <RadioPicker
              label={t('style.title')}
              hint={t('style.hint')}
              value={settings.style}
              options={[
                { value: 'solid', label: t('style.solid') },
                { value: 'dashed', label: t('style.dashed') },
                { value: 'dotted', label: t('style.dotted') },
                { value: 'double', label: t('style.double') },
              ]}
              onChange={v => patch('style', v as DividerStyle)}
            />

            <RadioPicker
              label={t('thickness.title')}
              hint={t('thickness.hint')}
              value={String(settings.thickness)}
              options={[
                { value: '1', label: t('thickness.1') },
                { value: '2', label: t('thickness.2') },
                { value: '3', label: t('thickness.3') },
              ]}
              onChange={v => patch('thickness', Number(v) as DividerThickness)}
            />

            <RadioPicker
              label={t('width.title')}
              hint={t('width.hint')}
              value={settings.width}
              options={[
                { value: 'full', label: t('width.full') },
                { value: 'contained', label: t('width.contained') },
                { value: 'short', label: t('width.short') },
              ]}
              onChange={v => patch('width', v as DividerWidth)}
            />

            <RadioPicker
              label={t('color.title')}
              hint={t('color.hint')}
              value={settings.color}
              options={[
                { value: 'auto', label: t('color.auto') },
                { value: 'foreground', label: t('color.foreground') },
                { value: 'accent', label: t('color.accent') },
                { value: 'custom', label: t('color.custom') },
              ]}
              onChange={v => patch('color', v as DividerColorMode)}
            />

            {settings.color === 'custom' && (
              <label className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
                <span className="text-sm text-foreground">{t('color.customLabel')}</span>
                <input
                  type="color"
                  value={settings.customColor ?? '#cccccc'}
                  onChange={e => patch('customColor', e.target.value)}
                  className="h-10 w-16 cursor-pointer rounded border border-border"
                />
                <span className="font-mono text-sm text-muted-foreground">
                  {settings.customColor ?? '#cccccc'}
                </span>
              </label>
            )}

            <RadioPicker
              label={t('spacing.title')}
              hint={t('spacing.hint')}
              value={settings.spacing}
              options={[
                { value: 'tight', label: t('spacing.tight') },
                { value: 'normal', label: t('spacing.normal') },
                { value: 'loose', label: t('spacing.loose') },
              ]}
              onChange={v => patch('spacing', v as DividerSpacing)}
            />
          </fieldset>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isSaving ? t('saving') : t('save')}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted"
            >
              {t('resetDefaults')}
            </button>
            {saveMsg && <span className="text-sm text-muted-foreground">{saveMsg}</span>}
          </div>
        </div>

        {/* Live preview pane — sticky on desktop so it stays visible while tuning */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('preview')}
            </p>
            <DividerPreview settings={settings} primaryColor={theme.primaryColor} />
          </div>
        </aside>
      </div>
    </div>
  );
}

interface RadioPickerProps {
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

function RadioPicker({ label, hint, value, options, onChange }: RadioPickerProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map(opt => (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm transition-colors ${
              value === opt.value
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border text-muted-foreground hover:border-foreground/30'
            }`}
          >
            <input
              type="radio"
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

interface DividerPreviewProps {
  settings: DividerSettings;
  primaryColor?: string;
}

function DividerPreview({ settings, primaryColor }: DividerPreviewProps) {
  // Mirrors storefront resolveDividerColor exactly so what merchants see
  // here matches the live render to the pixel.
  const colorCss =
    settings.color === 'foreground'
      ? 'rgba(0, 0, 0, 0.25)'
      : settings.color === 'accent'
        ? primaryColor
          ? `hsl(${primaryColor})`
          : 'hsl(26, 100%, 50%)'
        : settings.color === 'custom'
          ? settings.customColor || '#cccccc'
          : '#e5e7eb';
  const padY = settings.spacing === 'tight' ? 16 : settings.spacing === 'loose' ? 48 : 28;
  const lineWidth =
    settings.width === 'full' ? '100%' : settings.width === 'short' ? '80px' : '90%';

  return (
    <div className="rounded-lg bg-muted/30 p-4">
      <div className="rounded bg-background p-3 text-center text-xs text-muted-foreground">
        Section above
      </div>
      <div
        className={settings.enabled ? '' : 'opacity-30'}
        style={{ paddingTop: padY, paddingBottom: padY }}
      >
        <div className="flex justify-center">
          <hr
            className="m-0 border-0 border-t"
            style={{
              borderTopStyle: settings.style,
              borderTopWidth: `${settings.thickness}px`,
              borderTopColor: colorCss,
              width: lineWidth,
            }}
          />
        </div>
      </div>
      <div className="rounded bg-background p-3 text-center text-xs text-muted-foreground">
        Section below
      </div>
    </div>
  );
}
