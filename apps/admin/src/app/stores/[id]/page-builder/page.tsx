'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import {
  resolveLayoutSettings,
  DEFAULT_THEME,
  type StoreLayoutSettings,
  type ProductCardDefaults,
  type HeroSlide,
  recommendedSizeTextForTemplate,
  type TemplateId,
  type StoreTheme,
  type CardFrameSize,
  type CardFrameWidth,
  type ZoneOverride,
  type SectionTypographyOverride,
  type ColorToken,
} from '@force/shared';

// ---------------------------------------------------------------------------
// Legacy color-format normalization
// ---------------------------------------------------------------------------
// The old standalone /typography page stored tokens as 'brand-primary',
// 'brand-secondary', 'brand-accent'. The new ColorField emits 'token:primary',
// 'token:secondary', 'token:accent'. Normalise on load so the Default-typography
// card shows the correct Primary/Secondary/Accent chip instead of "Custom hex…".
function normalizeLegacyColor(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value === 'brand-primary') return 'token:primary';
  if (value === 'brand-secondary') return 'token:secondary';
  if (value === 'brand-accent') return 'token:accent';
  return value;
}

function normalizeZoneColors(zone: ZoneOverride): ZoneOverride {
  if (!zone.color) return zone;
  const normalized = normalizeLegacyColor(zone.color);
  return normalized === zone.color ? zone : { ...zone, color: normalized };
}
import { ColorField } from '../../../../components/ColorField';
import { ZoneEditor } from '../../../../components/ZoneEditor';
import { SmartPaletteModal, type ThemeUpdates } from '../../../../components/SmartPaletteModal';
import { SectionPreview } from '../../../../components/SectionPreview';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Toggle } from '../../../../components/Toggle';
import { ImageUpload } from '../../../../components/ImageUpload';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { getStoreHref } from '../../../../lib/store-url';

interface StoreInfo {
  id: string;
  slug: string;
  domain?: string | null;
  /** Store template — used to resolve per-theme recommended upload sizes. */
  template?: TemplateId;
  /** Store theme — used by ColorField to resolve brand tokens for the contrast preview. */
  theme?: StoreTheme;
}

// Neutral fallback used by SectionPreview before the real theme loads from the
// API. DEFAULT_THEME from @force/shared is the platform neutral; any token
// resolution will produce sensible greys + white until storeInfo arrives.
const FALLBACK_THEME: StoreTheme = DEFAULT_THEME;

type SectionUpdater<K extends keyof StoreLayoutSettings> = (
  prev: StoreLayoutSettings[K]
) => StoreLayoutSettings[K];

export default function StoreLayoutPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('orders.layout');
  const { success: toastSuccess, error: toastError } = useToast();

  const [layout, setLayout] = useState<StoreLayoutSettings | null>(null);
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Global typography zones — fetched from the same typography endpoint as
  // the standalone /typography page. Populated in fetchData and used as
  // (a) placeholder "inherit" hints in per-section ZoneEditors and
  // (b) editable values in the "Default typography" SectionCard.
  const [globalZones, setGlobalZones] = useState<Record<string, ZoneOverride>>({});
  // Font sources from the typography endpoint — preserved on save so we never
  // overwrite the merchant's custom/Google font library with an empty array
  // when only the zones are edited from this page.
  const [typographyFonts, setTypographyFonts] = useState<unknown[]>([]);

  const fetchData = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      // Typography endpoint returns { success: true, data: { typography: { fonts, zones } } }
      const [layoutRes, storeRes, typographyRes] = await Promise.all([
        apiGet<{ layout: StoreLayoutSettings }>(`/api/v1/admin/stores/${storeId}/layout`),
        apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`),
        apiGet<{ typography: { fonts?: unknown[]; zones: Record<string, ZoneOverride> } }>(
          `/api/v1/stores/${storeId}/typography`
        ),
      ]);
      if (layoutRes.error) {
        toastError(t('loadError'));
      } else if (layoutRes.data?.layout) {
        setLayout(resolveLayoutSettings(layoutRes.data.layout));
      }
      if (storeRes.data?.store) {
        setStoreInfo(storeRes.data.store);
      }
      if (typographyRes.data?.typography) {
        // Preserve fonts so handleSave can round-trip them unchanged.
        setTypographyFonts(typographyRes.data.typography.fonts ?? []);

        if (typographyRes.data.typography.zones) {
          // Normalise legacy 'brand-*' color tokens to 'token:*' format so the
          // ColorField shows the correct chip instead of "Custom hex…".
          const raw = typographyRes.data.typography.zones;
          const normalized = Object.fromEntries(
            Object.entries(raw).map(([key, zone]) => [
              key,
              normalizeZoneColors(zone as ZoneOverride),
            ])
          );
          setGlobalZones(normalized);
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t, toastError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateSection = <K extends keyof StoreLayoutSettings>(
    key: K,
    updater: SectionUpdater<K>
  ) => {
    setLayout(prev => (prev ? { ...prev, [key]: updater(prev[key]) } : prev));
  };

  const handleSave = async () => {
    if (!layout) return;
    setIsSaving(true);
    try {
      const [layoutResult, typographyResult] = await Promise.allSettled([
        apiPut(`/api/v1/admin/stores/${storeId}/layout`, layout),
        apiPut(`/api/v1/stores/${storeId}/typography`, {
          fonts: typographyFonts,
          zones: globalZones,
        }),
      ]);

      const layoutFailed =
        layoutResult.status === 'rejected' ||
        (layoutResult.status === 'fulfilled' && !!layoutResult.value.error);
      const typographyFailed =
        typographyResult.status === 'rejected' ||
        (typographyResult.status === 'fulfilled' && !!typographyResult.value.error);

      if (layoutFailed && typographyFailed) {
        toastError(t('saveError'));
      } else if (layoutFailed) {
        toastError(t('saveErrorLayoutOnly'));
      } else if (typographyFailed) {
        toastError(t('saveErrorTypographyOnly'));
      } else {
        toastSuccess(t('saved'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Build a preview URL pointing at the storefront's home page. Prefer the
  // store's custom domain when available so the preview reflects the
  // production environment exactly; otherwise fall back to the platform
  // domain + path-based slug (`/<store-slug>`) — that is the route shape the
  // web app's middleware actually resolves; a `?storeSlug=` query gets
  // ignored and falls through to whichever store the platform serves at /.
  const previewUrl = storeInfo?.slug ? getStoreHref(storeInfo) : null;

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            Smart palette
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!layout || isSaving}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
      }
    >
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_480px]">
        <div className="space-y-4">
          {isLoading && (
            <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              …
            </div>
          )}

          {!isLoading && layout && (
            <>
              {/* Expand / Collapse all — one-shot DOM-mutation approach.
                  React state per-card would be a much bigger refactor;
                  <details> is uncontrolled so we flip `details.open` directly. */}
              <div className="mb-1 flex items-center justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => document.querySelectorAll('details').forEach(d => (d.open = true))}
                  className="text-muted-foreground hover:text-foreground underline"
                >
                  Expand all
                </button>
                <span className="text-muted-foreground">·</span>
                <button
                  type="button"
                  onClick={() =>
                    document.querySelectorAll('details').forEach(d => (d.open = false))
                  }
                  className="text-muted-foreground hover:text-foreground underline"
                >
                  Collapse all
                </button>
              </div>

              {/* Hero — single image OR autoplay slider. The two modes share
                  the same slide list; "Static" pins to the first slide and
                  hides the autoplay control. */}
              <SectionCard
                title={t('sections.hero.title')}
                description={t('sections.hero.description')}
                enabled={layout.hero.enabled}
                onToggle={v => updateSection('hero', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.hero.enabled}
              >
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {t('sections.hero.modeLabel')}
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={layout.hero.mode === 'single'}
                    onClick={() => updateSection('hero', s => ({ ...s, mode: 'single' }))}
                    label={t('sections.hero.modeSingle')}
                  />
                  <ModeButton
                    active={layout.hero.mode === 'slider'}
                    onClick={() => updateSection('hero', s => ({ ...s, mode: 'slider' }))}
                    label={t('sections.hero.modeSlider')}
                  />
                </div>
                <p className="mb-4 text-xs text-muted-foreground">
                  {layout.hero.mode === 'single'
                    ? t('sections.hero.modeSingleHint')
                    : t('sections.hero.modeSliderHint')}
                </p>
                {/* Autoplay only matters in slider mode — hide it entirely
                    when the merchant has picked the static single banner so
                    the form doesn't expose an irrelevant control. */}
                {layout.hero.mode === 'slider' && (
                  <NumberField
                    label={t('sections.hero.autoplay')}
                    value={layout.hero.autoplayMs}
                    min={1000}
                    max={30000}
                    step={500}
                    onChange={v => updateSection('hero', s => ({ ...s, autoplayMs: v }))}
                  />
                )}
                <SlidesEditor
                  slides={layout.hero.slides}
                  storeId={storeId}
                  storeTemplate={storeInfo?.template}
                  onChange={next => updateSection('hero', s => ({ ...s, slides: next }))}
                />
                <ColorField
                  label="Section background color"
                  value={layout.hero.bgColor}
                  onChange={v => updateSection('hero', s => ({ ...s, bgColor: v }))}
                  hint="Overrides the theme background preset for this section only."
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                {/* Per-section typography overrides — wins over the global zone for
                    this section only. Hero only exposes heading (heroHeadline global
                    zone is the placeholder). kicker/subtitle don't apply to hero. */}
                <SectionTypographyBlock
                  roles={['heading']}
                  typography={layout.hero.typography}
                  globalZones={{
                    heading: globalZones[ROLE_TO_GLOBAL_ZONE['heading']],
                  }}
                  onChangeRole={(role, next) =>
                    updateSection('hero', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('hero', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="Hero"
                    bgColor={layout.hero.bgColor}
                    cardFrameColor={undefined}
                    cardFrameWidth={undefined}
                    headingZone={layout.hero.typography?.heading}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Categories */}
              <SectionCard
                title={t('sections.categories.title')}
                description={t('sections.categories.description')}
                enabled={layout.categories.enabled}
                onToggle={v => updateSection('categories', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.categories.enabled}
              >
                {/* Desktop controls */}
                <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('sections.categories.desktopLabel')}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={layout.categories.layout === 'grid'}
                    onClick={() => updateSection('categories', s => ({ ...s, layout: 'grid' }))}
                    label={t('sections.categories.layoutGrid')}
                  />
                  <ModeButton
                    active={layout.categories.layout === 'horizontal'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layout: 'horizontal' }))
                    }
                    label={t('sections.categories.layoutHorizontal')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={layout.categories.captionPosition === 'below'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPosition: 'below' }))
                    }
                    label={t('sections.categories.captionBelow')}
                  />
                  <ModeButton
                    active={layout.categories.captionPosition === 'overlay'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPosition: 'overlay' }))
                    }
                    label={t('sections.categories.captionOverlay')}
                  />
                </div>
                <div className="mb-4">
                  <SelectField
                    label={t('sections.categories.desktopColumns')}
                    value={layout.categories.desktopColumns}
                    options={[2, 3, 4]}
                    onChange={v =>
                      updateSection('categories', s => ({
                        ...s,
                        desktopColumns: v as 2 | 3 | 4,
                      }))
                    }
                  />
                </div>

                {/* Mobile controls (split per 2026-05-16 mobile-ui-ship plan) */}
                <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('sections.categories.mobileLabel')}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={(layout.categories.layoutMobile ?? layout.categories.layout) === 'grid'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layoutMobile: 'grid' }))
                    }
                    label={t('sections.categories.layoutGrid')}
                  />
                  <ModeButton
                    active={
                      (layout.categories.layoutMobile ?? layout.categories.layout) === 'horizontal'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layoutMobile: 'horizontal' }))
                    }
                    label={t('sections.categories.layoutHorizontal')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={
                      (layout.categories.captionPositionMobile ??
                        layout.categories.captionPosition) === 'below'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPositionMobile: 'below' }))
                    }
                    label={t('sections.categories.captionBelow')}
                  />
                  <ModeButton
                    active={
                      (layout.categories.captionPositionMobile ??
                        layout.categories.captionPosition) === 'overlay'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({
                        ...s,
                        captionPositionMobile: 'overlay',
                      }))
                    }
                    label={t('sections.categories.captionOverlay')}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('sections.categories.mobileColumns')}
                    value={layout.categories.mobileColumns}
                    options={[1, 2, 3]}
                    onChange={v =>
                      updateSection('categories', s => ({
                        ...s,
                        mobileColumns: v as 1 | 2 | 3,
                      }))
                    }
                  />
                </div>
                <SectionTitleFields
                  title={layout.categories.title}
                  titleAr={layout.categories.titleAr}
                  labelEn={t('sections.categories.headingLabel')}
                  labelAr={t('sections.categories.headingArLabel')}
                  placeholderEn={t('sections.categories.headingPlaceholder')}
                  placeholderAr={t('sections.categories.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('categories', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('categories', s => ({ ...s, titleAr: v }))}
                />
                {/* Kicker (eyebrow badge) + Subtitle — bilingual, optional.
                    Kicker renders as a small colored chip above the title;
                    subtitle as a tagline below. AI Generate button fills
                    all 4 fields at once based on store context. Ahmad
                    2026-05-16. The two line-divider toggles below control
                    the editorial hairlines that flank the kicker/subtitle
                    text in the shared SectionHeading paths (products
                    carousel + horizontal-layout categories). Per-theme
                    grid-layout categories use a chip-style kicker that
                    doesn't have lines — toggles are a no-op there. */}
                <KickerSubtitleControls
                  storeId={storeId}
                  section="categories"
                  values={layout.categories}
                  onPatch={patch => updateSection('categories', s => ({ ...s, ...patch }))}
                />
                {/* Card size, aspect, and visual toggles — Ahmad 2026-05-16
                    'make categories smaller + add options through admin'. */}
                {/* Card size / aspect / toggles — native selects with
                    descriptive labels (SelectField only accepts flat
                    string arrays). */}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Card size</span>
                    <select
                      value={layout.categories.cardSize ?? 'sm'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardSize: e.target.value as 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="xxs">Tiniest (90/110px)</option>
                      <option value="xs">Extra small (120/140px)</option>
                      <option value="sm">Small (150/180px) — default</option>
                      <option value="md">Medium (200/240px)</option>
                      <option value="lg">Large (240/300px)</option>
                      <option value="xl">Extra large (280/360px)</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Image aspect</span>
                    <select
                      value={layout.categories.cardAspect ?? 'theme'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardAspect: e.target.value as
                            | 'theme'
                            | 'square'
                            | 'portrait'
                            | 'landscape',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="theme">Theme default (3:4 — 600×800)</option>
                      <option value="square">Square 1:1 (800×800)</option>
                      <option value="portrait">Portrait 3:4 (600×800)</option>
                      <option value="landscape">Landscape 4:3 (800×600)</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Card shape</span>
                    <select
                      value={layout.categories.cardShape ?? 'theme'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardShape: e.target.value as
                            | 'theme'
                            | 'circle'
                            | 'rounded-square'
                            | 'square'
                            | 'soft'
                            | 'portrait'
                            | 'landscape'
                            | 'pill',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="theme">Theme default</option>
                      <option value="circle">Circle (round, 1:1)</option>
                      <option value="rounded-square">Rounded square (soft, 1:1)</option>
                      <option value="square">Sharp square (1:1)</option>
                      <option value="soft">Soft rectangle (4:5)</option>
                      <option value="portrait">Portrait (3:4)</option>
                      <option value="landscape">Landscape (4:3)</option>
                      <option value="pill">Pill (horizontal, 2:1)</option>
                    </select>
                    <span className="text-[11px] text-muted-foreground/80">
                      Overrides the aspect ratio + rounded corners with one preset.
                    </span>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Card spacing</span>
                    <select
                      value={layout.categories.cardGap ?? 'normal'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardGap: e.target.value as 'tight' | 'normal' | 'loose' | 'xloose',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="tight">Tight (6-8px)</option>
                      <option value="normal">Normal (12-16px) — default</option>
                      <option value="loose">Loose (20-24px)</option>
                      <option value="xloose">Extra loose (32-40px)</option>
                    </select>
                  </label>
                  <RowToggle
                    label="Show category labels"
                    checked={layout.categories.showLabel !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showLabel: v }))}
                  />
                  <RowToggle
                    label="Hover effects"
                    checked={layout.categories.showHover !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showHover: v }))}
                  />
                  <RowToggle
                    label="Show frame around each card"
                    checked={!!layout.categories.showCardFrame}
                    onChange={v => updateSection('categories', s => ({ ...s, showCardFrame: v }))}
                  />
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Frame style</span>
                      <select
                        value={layout.categories.cardFrameStyle ?? 'soft'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameStyle: e.target.value as
                              | 'soft'
                              | 'outline'
                              | 'shadow'
                              | 'paper',
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="soft">Soft (rounded + light shadow) — default</option>
                        <option value="outline">Outline (2px border, no shadow)</option>
                        <option value="shadow">Shadow (larger drop shadow, no border)</option>
                        <option value="paper">Paper (editorial, larger padding)</option>
                      </select>
                    </label>
                  )}
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Border thickness</span>
                      <select
                        value={layout.categories.cardFrameWidth ?? 'thin'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameWidth: e.target.value as CardFrameWidth,
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="thin">Thin (1px) — default</option>
                        <option value="normal">Normal (2px)</option>
                        <option value="thick">Thick (4px)</option>
                        <option value="xthick">Extra thick (8px)</option>
                      </select>
                    </label>
                  )}
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">Frame size</span>
                      <select
                        value={layout.categories.cardFrameSize ?? 'normal'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameSize: e.target.value as CardFrameSize,
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="compact">Compact (8px padding)</option>
                        <option value="normal">Normal (12px padding) — default</option>
                        <option value="comfortable">Comfortable (16px padding)</option>
                        <option value="spacious">Spacious (24px padding)</option>
                      </select>
                    </label>
                  )}
                </div>
                {layout.categories.showCardFrame && (
                  <ColorField
                    label="Card frame color (this section)"
                    value={layout.categories.cardFrameColor}
                    onChange={v => updateSection('categories', s => ({ ...s, cardFrameColor: v }))}
                    hint="Overrides the theme border color for these category cards."
                    theme={storeInfo?.theme}
                    inheritFromToken="border"
                  />
                )}
                <ColorField
                  label="Section background color"
                  value={layout.categories.bgColor}
                  onChange={v => updateSection('categories', s => ({ ...s, bgColor: v }))}
                  hint="Overrides the theme background preset for this section only."
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel']}
                  typography={layout.categories.typography}
                  globalZones={Object.fromEntries(
                    (['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel'] as const).map(
                      r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]]
                    )
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('categories', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('categories', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="Categories"
                    bgColor={layout.categories.bgColor}
                    cardFrameColor={layout.categories.cardFrameColor}
                    cardFrameWidth={layout.categories.cardFrameWidth}
                    cardFrameSize={layout.categories.cardFrameSize}
                    headingZone={layout.categories.typography?.heading}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* New arrivals */}
              <SectionCard
                title={t('sections.newArrivals.title')}
                description={t('sections.newArrivals.description')}
                enabled={layout.newArrivals.enabled}
                onToggle={v => updateSection('newArrivals', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.newArrivals.enabled}
              >
                <NumberField
                  label={t('sections.newArrivals.limit')}
                  value={layout.newArrivals.limit}
                  min={1}
                  max={48}
                  step={1}
                  onChange={v => updateSection('newArrivals', s => ({ ...s, limit: v }))}
                />
                <SectionTitleFields
                  title={layout.newArrivals.title}
                  titleAr={layout.newArrivals.titleAr}
                  labelEn={t('sections.newArrivals.headingLabel')}
                  labelAr={t('sections.newArrivals.headingArLabel')}
                  placeholderEn={t('sections.newArrivals.headingPlaceholder')}
                  placeholderAr={t('sections.newArrivals.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('newArrivals', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('newArrivals', s => ({ ...s, titleAr: v }))}
                />
                <KickerSubtitleControls
                  storeId={storeId}
                  section="newArrivals"
                  values={layout.newArrivals}
                  onPatch={patch => updateSection('newArrivals', s => ({ ...s, ...patch }))}
                />
                <ProductCardControls
                  values={layout.newArrivals}
                  onChange={patch => updateSection('newArrivals', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme}
                />
                <ColorField
                  label="Section background color"
                  value={layout.newArrivals.bgColor}
                  onChange={v => updateSection('newArrivals', s => ({ ...s, bgColor: v }))}
                  hint="Overrides the theme background preset for this section only."
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={[
                    'heading',
                    'kicker',
                    'subtitle',
                    'seeAll',
                    'productName',
                    'productPrice',
                    'productCta',
                  ]}
                  typography={layout.newArrivals.typography}
                  globalZones={Object.fromEntries(
                    (
                      [
                        'heading',
                        'kicker',
                        'subtitle',
                        'seeAll',
                        'productName',
                        'productPrice',
                        'productCta',
                      ] as const
                    ).map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('newArrivals', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('newArrivals', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="New arrivals"
                    bgColor={layout.newArrivals.bgColor}
                    cardFrameColor={layout.newArrivals.cardFrameColor}
                    cardFrameWidth={layout.newArrivals.cardFrameWidth}
                    cardFrameSize={layout.newArrivals.cardFrameSize}
                    headingZone={layout.newArrivals.typography?.heading}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Best sellers */}
              <SectionCard
                title={t('sections.bestSellers.title')}
                description={t('sections.bestSellers.description')}
                enabled={layout.bestSellers.enabled}
                onToggle={v => updateSection('bestSellers', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.bestSellers.enabled}
              >
                <NumberField
                  label={t('sections.bestSellers.limit')}
                  value={layout.bestSellers.limit}
                  min={1}
                  max={48}
                  step={1}
                  onChange={v => updateSection('bestSellers', s => ({ ...s, limit: v }))}
                />
                <SectionTitleFields
                  title={layout.bestSellers.title}
                  titleAr={layout.bestSellers.titleAr}
                  labelEn={t('sections.bestSellers.headingLabel')}
                  labelAr={t('sections.bestSellers.headingArLabel')}
                  placeholderEn={t('sections.bestSellers.headingPlaceholder')}
                  placeholderAr={t('sections.bestSellers.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('bestSellers', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('bestSellers', s => ({ ...s, titleAr: v }))}
                />
                <KickerSubtitleControls
                  storeId={storeId}
                  section="bestSellers"
                  values={layout.bestSellers}
                  onPatch={patch => updateSection('bestSellers', s => ({ ...s, ...patch }))}
                />
                <ProductCardControls
                  values={layout.bestSellers}
                  onChange={patch => updateSection('bestSellers', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme}
                />
                <ColorField
                  label="Section background color"
                  value={layout.bestSellers.bgColor}
                  onChange={v => updateSection('bestSellers', s => ({ ...s, bgColor: v }))}
                  hint="Overrides the theme background preset for this section only."
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={[
                    'heading',
                    'kicker',
                    'subtitle',
                    'seeAll',
                    'productName',
                    'productPrice',
                    'productCta',
                  ]}
                  typography={layout.bestSellers.typography}
                  globalZones={Object.fromEntries(
                    (
                      [
                        'heading',
                        'kicker',
                        'subtitle',
                        'seeAll',
                        'productName',
                        'productPrice',
                        'productCta',
                      ] as const
                    ).map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('bestSellers', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('bestSellers', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="Best sellers"
                    bgColor={layout.bestSellers.bgColor}
                    cardFrameColor={layout.bestSellers.cardFrameColor}
                    cardFrameWidth={layout.bestSellers.cardFrameWidth}
                    cardFrameSize={layout.bestSellers.cardFrameSize}
                    headingZone={layout.bestSellers.typography?.heading}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Filter sidebar */}
              <SectionCard
                title={t('sections.filterSidebar.title')}
                description={t('sections.filterSidebar.description')}
                enabled={layout.filterSidebar.enabled}
                onToggle={v => updateSection('filterSidebar', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.filterSidebar.enabled}
              >
                <RowToggle
                  label={t('sections.filterSidebar.defaultOpen')}
                  checked={layout.filterSidebar.defaultOpen}
                  onChange={v => updateSection('filterSidebar', s => ({ ...s, defaultOpen: v }))}
                />
              </SectionCard>

              {/* Testimonials */}
              <SectionCard
                title={t('sections.testimonials.title')}
                description={t('sections.testimonials.description')}
                enabled={layout.testimonials.enabled}
                onToggle={v => updateSection('testimonials', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.testimonials.enabled}
              >
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label={t('sections.testimonials.minRating')}
                    value={layout.testimonials.minRating}
                    min={1}
                    max={5}
                    step={1}
                    onChange={v => updateSection('testimonials', s => ({ ...s, minRating: v }))}
                  />
                  <RowToggle
                    label={t('sections.testimonials.verifiedOnly')}
                    checked={layout.testimonials.verifiedOnly}
                    onChange={v => updateSection('testimonials', s => ({ ...s, verifiedOnly: v }))}
                  />
                </div>
                <SectionTitleFields
                  title={layout.testimonials.title}
                  titleAr={layout.testimonials.titleAr}
                  labelEn={t('sections.testimonials.headingLabel')}
                  labelAr={t('sections.testimonials.headingArLabel')}
                  placeholderEn={t('sections.testimonials.headingPlaceholder')}
                  placeholderAr={t('sections.testimonials.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('testimonials', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('testimonials', s => ({ ...s, titleAr: v }))}
                />
                <ColorField
                  label="Section background color"
                  value={layout.testimonials.bgColor}
                  onChange={v => updateSection('testimonials', s => ({ ...s, bgColor: v }))}
                  hint="Overrides the theme background preset for this section only."
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={['heading', 'kicker', 'subtitle']}
                  typography={layout.testimonials.typography}
                  globalZones={Object.fromEntries(
                    (['heading', 'kicker', 'subtitle'] as const).map(r => [
                      r,
                      globalZones[ROLE_TO_GLOBAL_ZONE[r]],
                    ])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('testimonials', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('testimonials', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="Testimonials"
                    bgColor={layout.testimonials.bgColor}
                    cardFrameColor={undefined}
                    cardFrameWidth={undefined}
                    headingZone={layout.testimonials.typography?.heading}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Product reviews (sibling of testimonials — both UGC) */}
              <SectionCard
                title={t('sections.reviewSection.title')}
                description={t('sections.reviewSection.description')}
                enabled={layout.reviewSection.enabled}
                onToggle={v => updateSection('reviewSection', s => ({ ...s, enabled: v }))}
                defaultExpanded={layout.reviewSection.enabled}
              ></SectionCard>

              {/* Product Card Defaults — global card controls that apply
                  to the PLP, search, and any product surface outside the
                  homepage carousels. Per-section settings above override
                  these for homepage new-arrivals + best-sellers. */}
              <SectionCard
                title="Product card defaults"
                description="Applied to the catalog, category, search, and any product surface outside the homepage. Per-section settings above override these for the homepage carousels."
                alwaysOn
                defaultExpanded={false}
              >
                <ProductCardControls
                  values={layout.productCardDefaults ?? {}}
                  onChange={patch =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            productCardDefaults: {
                              ...(prev.productCardDefaults ?? {}),
                              ...(patch as Partial<ProductCardDefaults>),
                            },
                          }
                        : prev
                    )
                  }
                  theme={storeInfo?.theme}
                />
                {/* Catalog-wide product card typography — applies to PLP, category, search.
                    Only productName / productPrice / productCta are relevant here. */}
                <SectionTypographyBlock
                  roles={['productName', 'productPrice', 'productCta']}
                  typography={layout.productCardDefaults?.typography}
                  globalZones={Object.fromEntries(
                    (['productName', 'productPrice', 'productCta'] as const).map(r => [
                      r,
                      globalZones[ROLE_TO_GLOBAL_ZONE[r]],
                    ])
                  )}
                  onChangeRole={(role, next) =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            productCardDefaults: {
                              ...(prev.productCardDefaults ?? {}),
                              typography: {
                                ...(prev.productCardDefaults?.typography ?? {}),
                                [role]: {
                                  ...(prev.productCardDefaults?.typography?.[
                                    role as keyof SectionTypographyOverride
                                  ] ?? {}),
                                  ...next,
                                },
                              },
                            },
                          }
                        : prev
                    )
                  }
                  onResetRole={role =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const rest = {
                        ...(prev.productCardDefaults?.typography ?? {}),
                      } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...prev,
                        productCardDefaults: {
                          ...(prev.productCardDefaults ?? {}),
                          typography: Object.keys(rest).length ? rest : undefined,
                        },
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preview
                  </p>
                  <SectionPreview
                    label="Product cards"
                    bgColor={undefined}
                    cardFrameColor={layout.productCardDefaults?.cardFrameColor}
                    cardFrameWidth={layout.productCardDefaults?.cardFrameWidth}
                    cardFrameSize={layout.productCardDefaults?.cardFrameSize}
                    headingZone={layout.productCardDefaults?.typography?.productName}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Sizing contract section removed 2026-05-16 — its 3 fields
                  (heroAspect / productImageAspect / categoryImageAspect)
                  were never consumed by the storefront. The per-section
                  cardAspect / cardShape controls on Categories +
                  NewArrivals + BestSellers are the actual source of truth
                  for image aspect ratios. The underlying type field
                  (`layout.sizing.*`) stays in DEFAULT_LAYOUT_SETTINGS for
                  back-compat with existing stores' saved JSON but isn't
                  surfaced in admin or read by render code. */}

              {/* Header + Footer typography — only truly platform-wide zones.
                  Section-specific zones (sectionTitle / sectionKicker / etc.)
                  have been moved into each section card above (Wave 3A).
                  Edits here update `globalZones` local state only.
                  Persistence via a parallel PUT /typography call in handleSave. */}
              <SectionCard
                title="Header + Footer typography (platform-wide)"
                description="These defaults apply to the header, footer, and announcement bar. Per-section typography is controlled in each section card above."
                alwaysOn
                defaultExpanded={false}
              >
                <div className="space-y-3">
                  {(['beforeHeader', 'header', 'storeName', 'footer', 'afterFooter'] as const).map(
                    zoneKey => (
                      <ZoneEditor
                        key={zoneKey}
                        zoneKey={zoneKey}
                        zoneLabel={GLOBAL_ZONE_LABELS[zoneKey] ?? zoneKey}
                        values={globalZones[zoneKey] ?? {}}
                        onChange={next =>
                          setGlobalZones(prev => ({
                            ...prev,
                            [zoneKey]: { ...(prev[zoneKey] ?? {}), ...next },
                          }))
                        }
                        onReset={() =>
                          setGlobalZones(prev => {
                            const next = { ...prev };
                            delete next[zoneKey];
                            return next;
                          })
                        }
                        theme={storeInfo?.theme}
                      />
                    )
                  )}
                </div>
              </SectionCard>
            </>
          )}
        </div>

        {/* Live preview pane — sticky on lg+, hidden on mobile to keep the
            forms front-and-centre on small screens. */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Preview</h3>
            {previewUrl ? (
              // The storefront's CSP refuses to be framed (X-Frame-Options:
              // DENY + frame-ancestors 'none'), which is correct for a
              // public e-commerce site to avoid clickjacking. We open the
              // preview in a new tab instead so changes are visible without
              // weakening storefront security.
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-2xl border border-border bg-card p-6 text-center hover:bg-muted transition-colors"
              >
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-foreground">Open storefront preview</p>
                <p className="mt-1 text-xs text-muted-foreground break-all">{previewUrl}</p>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Opens in a new tab — your storefront blocks framing for security.
                </p>
              </a>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
                Preview unavailable — the store has no slug or domain configured.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Click <strong>Save changes</strong> to refresh the preview with your latest toggles.
            </p>
          </div>
        </aside>
      </div>
      <SmartPaletteModal
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={storeInfo?.theme}
        onApply={async (palette, themeUpdates: ThemeUpdates) => {
          // 1. Apply palette to layout state (same as before).
          setLayout(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              hero: { ...prev.hero, bgColor: palette.hero.bgColor },
              categories: {
                ...prev.categories,
                bgColor: palette.categories.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.categories.cardFrameColor,
                cardFrameWidth: palette.categories.cardFrameWidth,
                cardFrameSize: palette.categories.cardFrameSize,
              },
              newArrivals: {
                ...prev.newArrivals,
                bgColor: palette.newArrivals.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.newArrivals.cardFrameColor,
                cardFrameWidth: palette.newArrivals.cardFrameWidth,
                cardFrameSize: palette.newArrivals.cardFrameSize,
              },
              bestSellers: {
                ...prev.bestSellers,
                bgColor: palette.bestSellers.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.bestSellers.cardFrameColor,
                cardFrameWidth: palette.bestSellers.cardFrameWidth,
                cardFrameSize: palette.bestSellers.cardFrameSize,
              },
              testimonials: { ...prev.testimonials, bgColor: palette.testimonials.bgColor },
            };
          });

          // 2. Persist brand-token updates to StoreTheme so ColorField "Brand: ..."
          //    picks resolve to the colors the merchant just chose. This is
          //    independent of the main Save button — merchant clicked Apply, so
          //    the theme is written immediately.
          const hasThemeUpdates =
            themeUpdates.primaryColor !== undefined || themeUpdates.accentColor !== undefined;
          if (hasThemeUpdates && storeInfo?.theme) {
            const updatedTheme = { ...storeInfo.theme, ...themeUpdates };
            try {
              const res = await apiPut(`/api/v1/stores/${storeId}/theme`, updatedTheme);
              if (res.error) {
                // Theme write failed but layout apply succeeded — surface a toast but
                // don't block the merchant. They can update brand colors in /branding.
                toastError(
                  'Brand colors saved to sections, but theme update failed. Update in Branding if needed.'
                );
              } else {
                // Refresh storeInfo so subsequent ColorField empty-state previews
                // show the new brand colors.
                const storeRes = await apiGet<{ store: StoreInfo }>(
                  `/api/v1/admin/stores/${storeId}`
                );
                if (storeRes.data?.store) {
                  setStoreInfo(storeRes.data.store);
                }
              }
            } catch {
              toastError(
                'Brand colors saved to sections, but theme update failed. Update in Branding if needed.'
              );
            }
          }
        }}
      />
    </AdminLayout>
  );
}

interface SectionCardProps {
  title: string;
  description: string;
  enabled?: boolean;
  alwaysOn?: boolean;
  onToggle?: (v: boolean) => void;
  /** When true the card renders expanded by default. Defaults to false. */
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

/**
 * Card-control row for sections that render image+text cards
 * (categories, newArrivals, bestSellers). Bundles size + aspect +
 * shape + spacing dropdowns and showLabel + showHover toggles.
 *
 * Values shape matches both `CategoriesSettings` and
 * `ProductCarouselSettings` — both have the same card-tuning fields,
 * so one component covers all 3 mount points.
 */
type CardControlsValues = {
  cardSize?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  cardAspect?: 'theme' | 'square' | 'portrait' | 'landscape';
  cardShape?:
    | 'theme'
    | 'circle'
    | 'rounded-square'
    | 'square'
    | 'soft'
    | 'portrait'
    | 'landscape'
    | 'pill';
  cardGap?: 'tight' | 'normal' | 'loose' | 'xloose';
  showLabel?: boolean;
  showHover?: boolean;
  showCardFrame?: boolean;
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
  /** Border width for the card frame — only visible when showCardFrame is on. */
  cardFrameWidth?: CardFrameWidth;
  /** Frame box padding — only visible when showCardFrame is on. */
  cardFrameSize?: CardFrameSize;
  /** Hex color for the card frame border — only visible when showCardFrame is on. */
  cardFrameColor?: string;
};

function ProductCardControls({
  values,
  onChange,
  theme,
}: {
  values: CardControlsValues;
  onChange: (patch: Partial<CardControlsValues>) => void;
  theme?: StoreTheme;
}) {
  return (
    <div className="mt-3 space-y-0">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Card size</span>
          <select
            value={values.cardSize ?? 'sm'}
            onChange={e => onChange({ cardSize: e.target.value as CardControlsValues['cardSize'] })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="xxs">Tiniest (90/110px)</option>
            <option value="xs">Extra small (120/140px)</option>
            <option value="sm">Small (150/180px) — default</option>
            <option value="md">Medium (200/240px)</option>
            <option value="lg">Large (240/300px)</option>
            <option value="xl">Extra large (280/360px)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Image aspect</span>
          <select
            value={values.cardAspect ?? 'theme'}
            onChange={e =>
              onChange({ cardAspect: e.target.value as CardControlsValues['cardAspect'] })
            }
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="theme">Theme default (3:4 — 600×800)</option>
            <option value="square">Square 1:1 (800×800)</option>
            <option value="portrait">Portrait 3:4 (600×800)</option>
            <option value="landscape">Landscape 4:3 (800×600)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Card shape</span>
          <select
            value={values.cardShape ?? 'theme'}
            onChange={e =>
              onChange({ cardShape: e.target.value as CardControlsValues['cardShape'] })
            }
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="theme">Theme default</option>
            <option value="circle">Circle (round, 1:1)</option>
            <option value="rounded-square">Rounded square (soft, 1:1)</option>
            <option value="square">Sharp square (1:1)</option>
            <option value="soft">Soft rectangle (4:5)</option>
            <option value="portrait">Portrait (3:4)</option>
            <option value="landscape">Landscape (4:3)</option>
            <option value="pill">Pill (horizontal, 2:1)</option>
          </select>
          <span className="text-[11px] text-muted-foreground/80">
            Overrides the aspect ratio + rounded corners with one preset.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Card spacing</span>
          <select
            value={values.cardGap ?? 'normal'}
            onChange={e => onChange({ cardGap: e.target.value as CardControlsValues['cardGap'] })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="tight">Tight (6-8px)</option>
            <option value="normal">Normal (12-16px) — default</option>
            <option value="loose">Loose (20-24px)</option>
            <option value="xloose">Extra loose (32-40px)</option>
          </select>
        </label>
        <RowToggle
          label="Show labels"
          checked={values.showLabel !== false}
          onChange={v => onChange({ showLabel: v })}
        />
        <RowToggle
          label="Hover effects"
          checked={values.showHover !== false}
          onChange={v => onChange({ showHover: v })}
        />
        <RowToggle
          label="Show frame around each card"
          checked={!!values.showCardFrame}
          onChange={v => onChange({ showCardFrame: v })}
        />
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Frame style</span>
            <select
              value={values.cardFrameStyle ?? 'soft'}
              onChange={e =>
                onChange({
                  cardFrameStyle: e.target.value as CardControlsValues['cardFrameStyle'],
                })
              }
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="soft">Soft (rounded + light shadow) — default</option>
              <option value="outline">Outline (2px border, no shadow)</option>
              <option value="shadow">Shadow (larger drop shadow, no border)</option>
              <option value="paper">Paper (editorial, larger padding)</option>
            </select>
          </label>
        )}
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Border thickness</span>
            <select
              value={values.cardFrameWidth ?? 'thin'}
              onChange={e => onChange({ cardFrameWidth: e.target.value as CardFrameWidth })}
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="thin">Thin (1px) — default</option>
              <option value="normal">Normal (2px)</option>
              <option value="thick">Thick (4px)</option>
              <option value="xthick">Extra thick (8px)</option>
            </select>
          </label>
        )}
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Frame size</span>
            <select
              value={values.cardFrameSize ?? 'normal'}
              onChange={e => onChange({ cardFrameSize: e.target.value as CardFrameSize })}
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="compact">Compact (8px padding)</option>
              <option value="normal">Normal (12px padding) — default</option>
              <option value="comfortable">Comfortable (16px padding)</option>
              <option value="spacious">Spacious (24px padding)</option>
            </select>
          </label>
        )}
      </div>
      {/* Card frame color — full-width below the grid so the color picker
          + clear button have room. Only shown when the frame toggle is on. */}
      {values.showCardFrame && (
        <ColorField
          label="Card frame color (this section)"
          value={values.cardFrameColor}
          onChange={v => onChange({ cardFrameColor: v })}
          hint="Overrides the theme border color for these cards."
          theme={theme}
          inheritFromToken="border"
        />
      )}
    </div>
  );
}

function SectionCard({
  title,
  description,
  enabled,
  alwaysOn,
  onToggle,
  defaultExpanded,
  children,
}: SectionCardProps) {
  return (
    <details
      open={defaultExpanded}
      className="rounded-2xl border border-border bg-card transition-colors"
    >
      <summary className="cursor-pointer list-none px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">{title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          {/* The enabled toggle is inside summary so merchant can flip it
              without expanding. stopPropagation prevents the click from
              also toggling the details open/closed state. */}
          {!alwaysOn && onToggle && (
            <div
              onClick={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              role="presentation"
            >
              <Toggle checked={!!enabled} onChange={onToggle} />
            </div>
          )}
        </div>
      </summary>
      {(alwaysOn || enabled) && children && (
        <div className="border-t border-border px-5 py-4 space-y-3">{children}</div>
      )}
    </details>
  );
}

// Human-readable labels for the global zone keys — mirrors the labeling
// convention from the /typography page so merchants see consistent names.
const GLOBAL_ZONE_LABELS: Record<string, string> = {
  beforeHeader: 'Announcement bar (top promo strip)',
  header: 'Page header (logo + nav)',
  storeName: 'Store name (in header)',
  sectionKicker: 'Section kicker (chip above title)',
  sectionTitle: 'Section heading',
  sectionSubtitle: 'Section subtitle',
  sectionSeeAll: 'Section "View All" link',
  categories: 'Category card labels',
  products: 'Products (base)',
  productName: 'Product name (card)',
  productPrice: 'Product price (card)',
  cta: 'Buttons + CTAs',
  filters: 'Filter sidebar',
  footer: 'Footer',
  afterFooter: 'Below footer',
};

/**
 * All supported per-section typography roles — extended 2026-05-19 (Wave 3A)
 * to cover product-card and category-card zones so section cards can host all
 * section-specific roles without merchants needing to scroll to the global card.
 */
type SectionTypographyRole =
  | 'heading'
  | 'kicker'
  | 'subtitle'
  | 'seeAll'
  | 'productName'
  | 'productPrice'
  | 'productCta'
  | 'categoryLabel';

/**
 * Maps each per-section typography role to the brand token it inherits from
 * by default when no color is explicitly set. Used to populate the inherited
 * brand-color hint in the ZoneEditor ColorField empty state.
 */
const ROLE_INHERIT: Record<SectionTypographyRole, ColorToken> = {
  heading: 'foreground',
  kicker: 'foreground',
  subtitle: 'foreground',
  seeAll: 'primary',
  productName: 'foreground',
  productPrice: 'foreground',
  productCta: 'primary',
  categoryLabel: 'foreground',
};

/** Human-readable label for each per-section typography role. */
const ROLE_LABELS: Record<SectionTypographyRole, string> = {
  heading: 'Section heading',
  kicker: 'Section kicker (chip above title)',
  subtitle: 'Section subtitle',
  seeAll: '"View All" link',
  productName: 'Product name',
  productPrice: 'Product price',
  productCta: 'Product CTA / button',
  categoryLabel: 'Category card label',
};

/**
 * Maps each per-section role to the corresponding global typography zone key.
 * Used as placeholder hints in the ZoneEditor so the merchant sees what they'd
 * inherit from the global settings before setting a per-section override.
 */
const ROLE_TO_GLOBAL_ZONE: Record<SectionTypographyRole, string> = {
  heading: 'sectionTitle',
  kicker: 'sectionKicker',
  subtitle: 'sectionSubtitle',
  seeAll: 'sectionSeeAll',
  productName: 'productName',
  productPrice: 'productPrice',
  productCta: 'cta',
  categoryLabel: 'categories',
};

/**
 * Per-section typography override block. Rendered at the bottom of each
 * SectionCard for sections that have heading / kicker / subtitle roles.
 * Each role maps to a `ZoneOverride` in `layout.<section>.typography`.
 *
 * The `globalZones` prop provides the corresponding global-zone values as
 * placeholder hints — so the merchant can see what they'd inherit from the
 * "Default typography" card below without needing to scroll there.
 */
function SectionTypographyBlock({
  roles,
  typography,
  globalZones,
  onChangeRole,
  onResetRole,
  theme,
}: {
  roles: ReadonlyArray<SectionTypographyRole>;
  typography: SectionTypographyOverride | undefined;
  /** Global zone values used as placeholder hints in each ZoneEditor. */
  globalZones: Partial<Record<SectionTypographyRole, ZoneOverride>>;
  onChangeRole: (role: SectionTypographyRole, next: Partial<ZoneOverride>) => void;
  onResetRole: (role: SectionTypographyRole) => void;
  theme: StoreTheme | undefined;
}) {
  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Section typography (overrides default)
      </h4>
      <p className="mb-3 text-[11px] text-muted-foreground/80">
        Override the default typography for each text role in this section only. Leave all fields
        empty to inherit from the Header + Footer typography defaults at the bottom of this page.
      </p>
      <div className="space-y-3">
        {roles.map(role => (
          <ZoneEditor
            key={role}
            zoneKey={`section.typography.${role}`}
            zoneLabel={ROLE_LABELS[role]}
            values={typography?.[role] ?? {}}
            placeholder={globalZones[role]}
            onChange={next => onChangeRole(role, next)}
            onReset={() => onResetRole(role)}
            theme={theme}
            inheritFromToken={ROLE_INHERIT[role]}
          />
        ))}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => {
          const raw = e.target.value;
          const parsed = typeof options[0] === 'number' ? (Number(raw) as T) : (raw as T);
          onChange(parsed);
        }}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {options.map(o => (
          <option key={String(o)} value={o}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

// parseAspect + SizingFieldWithPreview removed 2026-05-16 alongside the
// Sizing contract SectionCard (heroAspect / productImageAspect /
// categoryImageAspect fields never consumed by the storefront — the
// per-section cardAspect / cardShape controls are the real source of
// truth for image aspect ratios).

function SectionTitleFields({
  title,
  titleAr,
  labelEn,
  labelAr,
  placeholderEn,
  placeholderAr,
  onChangeTitle,
  onChangeTitleAr,
}: {
  title: string | undefined;
  titleAr: string | undefined;
  labelEn: string;
  labelAr: string;
  placeholderEn: string;
  placeholderAr: string;
  onChangeTitle: (v: string) => void;
  onChangeTitleAr: (v: string) => void;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
      <TextField
        label={labelEn}
        placeholder={placeholderEn}
        value={title ?? ''}
        onChange={onChangeTitle}
      />
      <TextField
        label={labelAr}
        placeholder={placeholderAr}
        value={titleAr ?? ''}
        onChange={onChangeTitleAr}
        dir="rtl"
      />
    </div>
  );
}

function RowToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span className="text-foreground">{label}</span>
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}

/**
 * Bundled controls for kicker + subtitle text (bilingual) AND the two
 * line-divider toggles that surround them (Ahmad 2026-05-17 night —
 * extracted from the inline Categories block so newArrivals + bestSellers
 * get the same surface). `showKickerLines` / `showSubtitleLines` default
 * to true (lines visible) and only affect rendering paths that use the
 * shared `SectionHeading` component (ProductCarousel + CategoryStrip).
 * Per-theme `CategoryGrid` paths render their own chip-style heading
 * which doesn't have flanking lines — toggles are a no-op there.
 */
type KickerSubtitleValues = {
  kicker?: string;
  kickerAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  title?: string;
  titleAr?: string;
  showKickerLines?: boolean;
  showSubtitleLines?: boolean;
};

function KickerSubtitleControls({
  storeId,
  section,
  values,
  onPatch,
}: {
  storeId: string;
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  values: KickerSubtitleValues;
  onPatch: (patch: Partial<KickerSubtitleValues>) => void;
}) {
  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Optional kicker + subtitle. Leave blank to skip.
        </p>
        <AiSectionFillButton
          storeId={storeId}
          section={section}
          existingTitle={values.title}
          existingTitleAr={values.titleAr}
          onFilled={r =>
            onPatch({
              kicker: values.kicker || r.kicker,
              kickerAr: values.kickerAr || r.kickerAr,
              subtitle: values.subtitle || r.subtitle,
              subtitleAr: values.subtitleAr || r.subtitleAr,
            })
          }
        />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label="Kicker label (EN)"
          placeholder="e.g. EXPLORE"
          value={values.kicker ?? ''}
          onChange={v => onPatch({ kicker: v })}
        />
        <TextField
          label="Kicker label (AR)"
          placeholder="مثال: استكشف"
          value={values.kickerAr ?? ''}
          onChange={v => onPatch({ kickerAr: v })}
          dir="rtl"
        />
        <TextField
          label="Subtitle (EN)"
          placeholder="e.g. Browse our top picks"
          value={values.subtitle ?? ''}
          onChange={v => onPatch({ subtitle: v })}
        />
        <TextField
          label="Subtitle (AR)"
          placeholder="مثال: تصفح أفضل اختياراتنا"
          value={values.subtitleAr ?? ''}
          onChange={v => onPatch({ subtitleAr: v })}
          dir="rtl"
        />
      </div>
      <div className="mt-3 rounded-lg border border-dashed border-border bg-muted/20 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Heading line dividers
        </p>
        <p className="mb-3 text-[11px] text-muted-foreground/80">
          Two short hairline rules drawn before and after the kicker / subtitle text. Turn off for a
          cleaner look without the surrounding lines.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <RowToggle
            label="Show lines around kicker"
            checked={values.showKickerLines !== false}
            onChange={v => onPatch({ showKickerLines: v })}
          />
          <RowToggle
            label="Show lines around subtitle"
            checked={values.showSubtitleLines !== false}
            onChange={v => onPatch({ showSubtitleLines: v })}
          />
        </div>
      </div>
    </>
  );
}

/**
 * "Generate with AI" button used next to section content fields
 * (kicker + subtitle). Calls /ai/section-content + only fills empty
 * fields so a merchant's existing values aren't overwritten. Loading
 * state + success/error toast included.
 */
function AiSectionFillButton({
  storeId,
  section,
  existingTitle,
  existingTitleAr,
  onFilled,
}: {
  storeId: string;
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  existingTitle?: string;
  existingTitleAr?: string;
  onFilled: (r: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();
  const generate = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        suggestion: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string };
      }>(`/api/v1/stores/${storeId}/ai/section-content`, {
        section,
        existingTitle: existingTitle || undefined,
        existingTitleAr: existingTitleAr || undefined,
      });
      if (error || !data) {
        toastError('AI generation failed', error?.message ?? '');
        return;
      }
      onFilled(data.suggestion);
      toastSuccess('AI filled empty kicker + subtitle fields');
    } catch (e) {
      toastError('AI generation failed', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={generate}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-60 transition-colors cursor-pointer"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
      {busy ? 'Generating…' : 'Generate with AI'}
    </button>
  );
}

interface SlidesEditorProps {
  slides: HeroSlide[];
  storeId: string;
  storeTemplate: TemplateId | undefined;
  onChange: (next: HeroSlide[]) => void;
}

function SlidesEditor({ slides, storeId, storeTemplate, onChange }: SlidesEditorProps) {
  const t = useT('orders.layout.sections.hero.slides');

  const updateSlide = (index: number, patch: Partial<HeroSlide>) => {
    onChange(slides.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeSlide = (index: number) => {
    onChange(slides.filter((_, i) => i !== index));
  };

  const moveSlide = (from: number, to: number) => {
    if (to < 0 || to >= slides.length) return;
    const next = [...slides];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const addSlide = () => {
    onChange([
      ...slides,
      { image: '', alt: '', headline: '', headlineAr: '', ctaText: '', ctaTextAr: '', ctaHref: '' },
    ]);
  };

  return (
    <div className="mt-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t('description')}</p>
      </div>

      {slides.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-center text-xs text-muted-foreground">
          {t('empty')}
        </p>
      )}

      <ul className="space-y-4">
        {slides.map((slide, index) => (
          <li key={index} className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">
                {t('slideLabel', { index: index + 1 })}
              </span>
              <div className="flex items-center gap-1">
                <IconButton
                  label={t('moveUp')}
                  disabled={index === 0}
                  onClick={() => moveSlide(index, index - 1)}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </IconButton>
                <IconButton
                  label={t('moveDown')}
                  disabled={index === slides.length - 1}
                  onClick={() => moveSlide(index, index + 1)}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </IconButton>
                <IconButton label={t('remove')} variant="danger" onClick={() => removeSlide(index)}>
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </IconButton>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                {/* Desktop image — wide cinematic crop */}
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {t('imageDesktop')}
                    </label>
                    <span className="text-[10px] text-muted-foreground">
                      {t('imageDesktopHint')}
                    </span>
                  </div>
                  <ImageUpload
                    value={slide.image || undefined}
                    folder="hero"
                    storeId={storeId}
                    onUpload={url => updateSlide(index, { image: url })}
                    onRemove={() => updateSlide(index, { image: '' })}
                    recommendedSizeHint={recommendedSizeTextForTemplate(
                      'heroDesktop',
                      storeTemplate
                    )}
                  />
                  <div className="mt-3">
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('imageDesktopAr')}
                    </label>
                    <ImageUpload
                      value={slide.imageAr || undefined}
                      folder="hero"
                      storeId={storeId}
                      onUpload={url => updateSlide(index, { imageAr: url })}
                      onRemove={() => updateSlide(index, { imageAr: '' })}
                      recommendedSizeHint={recommendedSizeTextForTemplate(
                        'heroDesktop',
                        storeTemplate
                      )}
                    />
                  </div>
                </div>

                {/* Mobile image — taller crop, optional but recommended */}
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {t('imageMobile')}
                    </label>
                    <span className="text-[10px] text-muted-foreground">
                      {t('imageMobileHint')}
                    </span>
                  </div>
                  <ImageUpload
                    value={slide.imageMobile || undefined}
                    folder="hero"
                    storeId={storeId}
                    onUpload={url => updateSlide(index, { imageMobile: url })}
                    onRemove={() => updateSlide(index, { imageMobile: '' })}
                    recommendedSizeHint={recommendedSizeTextForTemplate(
                      'heroMobile',
                      storeTemplate
                    )}
                  />
                  <div className="mt-3">
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('imageMobileAr')}
                    </label>
                    <ImageUpload
                      value={slide.imageMobileAr || undefined}
                      folder="hero"
                      storeId={storeId}
                      onUpload={url => updateSlide(index, { imageMobileAr: url })}
                      onRemove={() => updateSlide(index, { imageMobileAr: '' })}
                      recommendedSizeHint={recommendedSizeTextForTemplate(
                        'heroMobile',
                        storeTemplate
                      )}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <TextField
                  label={t('alt')}
                  placeholder={t('altPlaceholder')}
                  value={slide.alt ?? ''}
                  onChange={v => updateSlide(index, { alt: v })}
                />
                <TextField
                  label={t('headline')}
                  placeholder={t('headlinePlaceholder')}
                  value={slide.headline ?? ''}
                  onChange={v => updateSlide(index, { headline: v })}
                />
                <TextField
                  label={t('headlineAr')}
                  placeholder={t('headlineArPlaceholder')}
                  value={slide.headlineAr ?? ''}
                  onChange={v => updateSlide(index, { headlineAr: v })}
                  dir="rtl"
                />
                <TextField
                  label={t('ctaText')}
                  placeholder={t('ctaTextPlaceholder')}
                  value={slide.ctaText ?? ''}
                  onChange={v => updateSlide(index, { ctaText: v })}
                />
                <TextField
                  label={t('ctaTextAr')}
                  placeholder={t('ctaTextArPlaceholder')}
                  value={slide.ctaTextAr ?? ''}
                  onChange={v => updateSlide(index, { ctaTextAr: v })}
                  dir="rtl"
                />
                <TextField
                  label={t('ctaHref')}
                  placeholder={t('ctaHrefPlaceholder')}
                  value={slide.ctaHref ?? ''}
                  onChange={v => updateSlide(index, { ctaHref: v })}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={addSlide}
        className="inline-flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        {t('add')}
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  dir,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  dir?: 'ltr' | 'rtl';
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        dir={dir}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function IconButton({
  label,
  disabled,
  variant = 'default',
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const styles =
    variant === 'danger'
      ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}
