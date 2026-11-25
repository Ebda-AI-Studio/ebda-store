'use client';

import { Button } from '@/components/ui/Button';
import { SparkleIcon } from './SparkleIcon';
import { useState, useEffect } from 'react';
import {
  generateSectionPalette,
  deriveCoreBrandTokens,
  DEFAULT_THEME,
  getTemplatePresets,
  getVibePreset,
} from '@ebda/shared';
import type {
  StoreTheme,
  SectionKey,
  PaletteSeeds,
  SectionPaletteEntry,
  PalettePattern,
  CardFrameSize,
  CardFrameWidth,
  VibeId,
  TemplateId,
} from '@ebda/shared';
import { hexToHsl } from '../lib/color';
import { ColorField } from './ColorField';
import { SectionPreview } from './SectionPreview';
import { apiPost } from '../lib/api';
import { useT } from '../i18n/useT';
import { useConfirm } from '../hooks/useConfirm';
import { FIELD_CLASSES } from '@/components/ui/tokens';

/**
 * Brand-color updates the parent should persist to StoreTheme on apply.
 * Only populated when the merchant explicitly typed/picked a raw hex value —
 * if they selected an existing token ('token:primary') no theme update is needed.
 *
 * Includes all core brand token keys so the Smart Palette can fill the full
 * Branding color editor (2026-06-16: deriveCoreBrandTokens writes all tokens).
 */
export interface ThemeUpdates {
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  cardColor?: string;
  mutedColor?: string;
  borderColor?: string;
  /** Written with borderColor by deriveCoreBrandTokens (Ruling B1-43). */
  inputColor?: string;
  primaryForeground?: string;
  secondaryForeground?: string;
  accentForeground?: string;
  cardForeground?: string;
  /** Card-level toggles staged from the editor's "Product cards" group
   *  card (Ahmad 2026-05-20: moved from branding/ThemeTab). */
  showBrandBadge?: boolean;
  /** Ruling D1016-NEW-1 — the card "New" badge, merchant's choice, default off. */
  showNewBadge?: boolean;
  showQuickAdd?: boolean;
  /** #1998 — keep the legacy bottom-left sale-badge corner (visual editor toggle). */
  saleBadgeLegacyCorner?: boolean;
  /** Item 6 — hide price on all product cards store-wide. Default true. */
  showPriceOnCards?: boolean;
  /** Item 10 — force object-fit:cover on card images to create a uniform grid. Default false. */
  normalizeProductImages?: boolean;
  /** Order-summary label colors (cart / checkout / address pages). */
  summaryLabelColor?: string;
  summaryTotalColor?: string;
  summaryLabelBold?: boolean;
  /** #2349 — keep the legacy (lighter) status-message colours (visual editor → Cart page). */
  legacyBannerContrast?: boolean;
  /** Products listing page (PLP) text colors. */
  plpBreadcrumbColor?: string;
  plpHeadingColor?: string;
  plpSubheadingColor?: string;
}

interface SmartPaletteModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called when merchant clicks "Apply to all sections".
   * `palette` contains per-section bg/frame settings.
   * `themeUpdates` contains the resolved HSL triplets for brand tokens that
   * should be persisted back to StoreTheme so ColorField "Brand: ..." picks
   * resolve to the colors the merchant just chose.
   */
  onApply: (palette: Record<SectionKey, SectionPaletteEntry>, themeUpdates: ThemeUpdates) => void;
  theme: StoreTheme | undefined;
  /** Store ID — used for the AI logo extraction call (Layer C). */
  storeId?: string;
  /** Active template — used to pre-fill seeds on modal open (Layer A). */
  storeTemplate?: TemplateId;
}

const SECTION_KEYS: SectionKey[] = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'testimonials',
];

const VIBE_IDS: VibeId[] = [
  'luxury',
  'boutique',
  'grocery',
  'streetwear',
  'minimal',
  'tech',
  'restaurant',
  'cafe',
  'beauty',
];

export function SmartPaletteModal({
  open,
  onClose,
  onApply,
  theme,
  storeId,
  storeTemplate,
}: SmartPaletteModalProps) {
  const t = useT('components.smartPalette');
  const askConfirm = useConfirm();

  // Layer A: template-derived defaults (lowest priority)
  const templateSeeds = getTemplatePresets(storeTemplate);

  const defaultPrimary = templateSeeds?.primary ?? 'token:primary';
  const defaultAccent = templateSeeds?.accent ?? '';
  const defaultNeutral = templateSeeds?.neutral ?? '';
  const defaultPattern: PalettePattern = templateSeeds?.pattern ?? 'alternating';
  const defaultFrameWidth: CardFrameWidth = templateSeeds?.cardFrameWidth ?? 'normal';
  const defaultFrameSize: CardFrameSize = templateSeeds?.cardFrameSize ?? 'normal';

  const [primary, setPrimary] = useState<string>(defaultPrimary);
  const [accent, setAccent] = useState<string>(defaultAccent);
  const [neutral, setNeutral] = useState<string>(defaultNeutral);
  const [pattern, setPattern] = useState<PalettePattern>(defaultPattern);
  const [paletteFrameWidth, setPaletteFrameWidth] = useState<CardFrameWidth>(defaultFrameWidth);
  const [paletteFrameSize, setPaletteFrameSize] = useState<CardFrameSize>(defaultFrameSize);
  const [overrides, setOverrides] = useState<
    Partial<Record<SectionKey, Partial<SectionPaletteEntry>>>
  >({});
  const [expandedSection, setExpandedSection] = useState<SectionKey | null>(null);

  // Layer B: active vibe selection
  const [activeVibe, setActiveVibe] = useState<VibeId | null>(null);

  // Layer C: AI logo extraction state
  const [logoLoading, setLogoLoading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Re-apply Layer A defaults whenever the modal opens or the template changes.
  // This ensures "reset to template defaults" works correctly without a
  // separate reset handler — reopening the modal re-seeds from the template.
  useEffect(() => {
    if (!open) return;
    const seeds = getTemplatePresets(storeTemplate);
    setPrimary(seeds?.primary ?? 'token:primary');
    setAccent(seeds?.accent ?? '');
    setNeutral(seeds?.neutral ?? '');
    setPattern(seeds?.pattern ?? 'alternating');
    setPaletteFrameWidth(seeds?.cardFrameWidth ?? 'normal');
    setPaletteFrameSize(seeds?.cardFrameSize ?? 'normal');
    setActiveVibe(null);
    setOverrides({});
    setExpandedSection(null);
    setLogoError(null);
  }, [open, storeTemplate]);

  if (!open) return null;

  // Resolved theme — fall back to DEFAULT_THEME so SectionPreview always gets
  // a valid StoreTheme object even when the store hasn't been saved yet.
  const resolvedTheme = theme ?? DEFAULT_THEME;

  const seeds: PaletteSeeds = {
    primary,
    accent: accent || undefined,
    neutral: neutral || undefined,
    pattern,
    cardFrameWidth: paletteFrameWidth,
    cardFrameSize: paletteFrameSize,
    overrides,
  };
  const palette = primary ? generateSectionPalette(seeds, resolvedTheme) : null;

  // Layer B: apply vibe preset — overrides seeds + pattern + frame
  function applyVibe(vibeId: VibeId) {
    const preset = getVibePreset(vibeId);
    if (!preset) return;
    setActiveVibe(vibeId);
    setPrimary(preset.primary);
    setAccent(preset.accent);
    setNeutral(preset.neutral);
    setPattern(preset.pattern);
    setPaletteFrameWidth(preset.cardFrameWidth);
    setPaletteFrameSize(preset.cardFrameSize);
    // Clear per-section overrides when switching vibe so the new vibe
    // is fully applied without leftover overrides interfering.
    setOverrides({});
  }

  // Layer A: reset to template defaults
  function resetToTemplateDefaults() {
    const seeds = getTemplatePresets(storeTemplate);
    setPrimary(seeds?.primary ?? 'token:primary');
    setAccent(seeds?.accent ?? '');
    setNeutral(seeds?.neutral ?? '');
    setPattern(seeds?.pattern ?? 'alternating');
    setPaletteFrameWidth(seeds?.cardFrameWidth ?? 'normal');
    setPaletteFrameSize(seeds?.cardFrameSize ?? 'normal');
    setActiveVibe(null);
    setOverrides({});
  }

  // Layer C: AI logo extraction
  async function handleLogoSuggest() {
    if (!storeId) {
      setLogoError(t('errors.noStoreId'));
      return;
    }
    setLogoLoading(true);
    setLogoError(null);
    try {
      const res = await apiPost<{ primary: string; accent: string; neutral: string }>(
        `/api/v1/stores/${storeId}/ai/palette-from-logo`,
        {}
      );
      if (res.error) {
        const code = (res.error as { code?: string }).code;
        if (code === 'NO_LOGO') {
          setLogoError(t('errors.noLogo'));
        } else if (code === 'AI_QUOTA_EXCEEDED' || code === 'AI_QUOTA_DAILY_EXCEEDED') {
          setLogoError(t('errors.quotaExceeded'));
        } else {
          setLogoError(res.error.message ?? t('errors.extractionFailed'));
        }
        return;
      }
      if (res.data) {
        // AI suggestion overrides seeds (highest priority before manual edits).
        setPrimary(res.data.primary);
        setAccent(res.data.accent);
        setNeutral(res.data.neutral);
        // Clear any active vibe so the AI result is the clean baseline.
        setActiveVibe(null);
      }
    } catch {
      setLogoError(t('errors.extractionFailedRetry'));
    } finally {
      setLogoLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground">{t('title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('description')}</p>

        {/* Layer C: AI logo suggestion button */}
        <div className="mb-4 flex items-center gap-3">
          <Button
            variant="outline"
            type="button"
            onClick={handleLogoSuggest}
            disabled={logoLoading || !storeId}
            className="gap-2"
          >
            {logoLoading ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <SparkleIcon />
            )}
            {logoLoading ? t('extracting') : t('suggestFromLogo')}
          </Button>
          {logoError ? (
            <span className="text-xs text-destructive-ink">{logoError}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('logoHint')}</span>
          )}
        </div>

        {/* Layer B: Vibe picker */}
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('vibeSection')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {VIBE_IDS.map(vibeId => (
              <Button
                variant={activeVibe === vibeId ? 'soft' : 'outline'}
                size="sm"
                key={vibeId}
                type="button"
                onClick={() => applyVibe(vibeId)}
              >
                {t(`vibeLabels.${vibeId}` as Parameters<typeof t>[0])}
              </Button>
            ))}
          </div>
        </div>

        {/* Distribution sub-section: pattern + frame thickness */}
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('distributionSection')}
          </h3>
          <div className="mb-3">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              {t('patternLabel')}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['alternating', 'monochrome', 'triad', 'single-bg'] as const).map(p => (
                <Button
                  variant={pattern === p ? 'soft' : 'outline'}
                  size="sm"
                  key={p}
                  type="button"
                  onClick={() => setPattern(p)}
                >
                  {t(`patternLabels.${p}` as Parameters<typeof t>[0])}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              {t('frameThicknessLabel')}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['thin', 'normal', 'thick', 'xthick'] as const).map(w => (
                <Button
                  variant={paletteFrameWidth === w ? 'soft' : 'outline'}
                  size="sm"
                  key={w}
                  type="button"
                  onClick={() => setPaletteFrameWidth(w)}
                >
                  {t(`frame${w.charAt(0).toUpperCase()}${w.slice(1)}` as Parameters<typeof t>[0])}
                </Button>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              {t('frameSizeLabel')}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['compact', 'normal', 'comfortable', 'spacious'] as const).map(s => (
                <Button
                  variant={paletteFrameSize === s ? 'soft' : 'outline'}
                  size="sm"
                  key={s}
                  type="button"
                  onClick={() => setPaletteFrameSize(s)}
                  className="capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {/* Seed color inputs + Layer A reset link */}
        <div className="space-y-3">
          <ColorField
            label={t('primaryLabel')}
            value={primary}
            onChange={setPrimary}
            theme={theme}
          />
          <ColorField label={t('accentLabel')} value={accent} onChange={setAccent} theme={theme} />
          <ColorField
            label={t('neutralLabel')}
            value={neutral}
            onChange={setNeutral}
            theme={theme}
          />
          {/* Layer A: reset link — only shown when template has a preset */}
          {getTemplatePresets(storeTemplate) ? (
            <div className="flex justify-end">
              <Button
                variant="link"
                size="sm"
                type="button"
                onClick={resetToTemplateDefaults}
                className="text-muted-foreground"
              >
                {t('resetToDefaults')}
              </Button>
            </div>
          ) : null}
        </div>

        {/* Interactive preview grid — click any section to override */}
        {palette ? (
          <div className="mt-6">
            <p className="mb-2 text-xs text-muted-foreground">{t('previewHint')}</p>
            <div className="grid grid-cols-5 gap-2">
              {SECTION_KEYS.map(key => (
                <div key={key} className="min-h-[180px]">
                  <button
                    data-ui="tile"
                    type="button"
                    onClick={() => setExpandedSection(prev => (prev === key ? null : key))}
                    className={`h-full w-full rounded-lg border-2 transition-colors ${
                      expandedSection === key
                        ? 'border-primary'
                        : 'border-transparent hover:border-primary/40'
                    }`}
                    aria-expanded={expandedSection === key}
                  >
                    <SectionPreview
                      label={t(`sectionLabels.${key}` as Parameters<typeof t>[0])}
                      bgColor={palette[key].bgColor}
                      cardFrameColor={palette[key].cardFrameColor}
                      cardFrameWidth={palette[key].cardFrameWidth}
                      cardFrameSize={palette[key].cardFrameSize}
                      headingZone={undefined}
                      theme={resolvedTheme}
                    />
                  </button>
                </div>
              ))}
            </div>
            {/* Override editor renders BELOW the tile row so it gets the full
                modal width (5 columns combined) instead of 1/5 — otherwise the
                3 ColorFields + select inside overlap inside a ~150px column. */}
            {expandedSection ? (
              <div className="mt-3 rounded-lg border border-primary/40 bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('overridePrefix')}{' '}
                    {t(`sectionLabels.${expandedSection}` as Parameters<typeof t>[0])}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => setExpandedSection(null)}
                    className="text-muted-foreground"
                    aria-label={t('closeOverrideEditor')}
                  >
                    ✕
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ColorField
                    label={t('overrideBgLabel')}
                    value={overrides[expandedSection]?.bgColor}
                    onChange={v =>
                      setOverrides(prev => ({
                        ...prev,
                        [expandedSection]: { ...prev[expandedSection], bgColor: v },
                      }))
                    }
                    theme={theme}
                    inheritFromToken="card"
                    showContrastPreview={false}
                  />
                  <ColorField
                    label={t('overrideFrameLabel')}
                    value={overrides[expandedSection]?.cardFrameColor}
                    onChange={v =>
                      setOverrides(prev => ({
                        ...prev,
                        [expandedSection]: { ...prev[expandedSection], cardFrameColor: v },
                      }))
                    }
                    theme={theme}
                    inheritFromToken="border"
                    showContrastPreview={false}
                  />
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('overrideThicknessLabel')}</span>
                    <select
                      value={
                        overrides[expandedSection]?.cardFrameWidth ??
                        palette[expandedSection].cardFrameWidth
                      }
                      onChange={e =>
                        setOverrides(prev => ({
                          ...prev,
                          [expandedSection]: {
                            ...prev[expandedSection],
                            cardFrameWidth: e.target.value as CardFrameWidth,
                          },
                        }))
                      }
                      className={FIELD_CLASSES}
                    >
                      <option value="thin">{t('frameThin')}</option>
                      <option value="normal">{t('frameNormal')}</option>
                      <option value="thick">{t('frameThick')}</option>
                      <option value="xthick">{t('frameXthick')}</option>
                    </select>
                  </label>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  type="button"
                  onClick={() =>
                    setOverrides(prev => {
                      const next = { ...prev };
                      delete next[expandedSection];
                      return next;
                    })
                  }
                  className="mt-3 text-muted-foreground"
                >
                  {t('resetSection')}
                </Button>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">{t('tokenHint')}</p>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            onClick={async () => {
              if (!palette) return;
              if (
                !(await askConfirm({
                  object: t('applyConfirmObject'),
                  consequence: t('applyConfirm'),
                  confirmLabel: t('applyConfirmLabel'),
                  tone: 'default',
                }))
              )
                return;

              // Build theme updates: only when the merchant entered a raw hex
              // (not a token ref). Convert hex → HSL triplet to match the
              // format StoreTheme stores (e.g. '36 36% 52%').
              //
              // When a concrete primary hex is available, derive ALL core brand
              // tokens so the Branding color editor fields get filled on apply.
              const themeUpdates: ThemeUpdates = {};
              if (primary && !primary.startsWith('token:')) {
                const coreTokens = deriveCoreBrandTokens({
                  primary,
                  accent: accent && !accent.startsWith('token:') ? accent : undefined,
                  neutral: neutral && !neutral.startsWith('token:') ? neutral : undefined,
                });
                Object.assign(themeUpdates, coreTokens);
              } else if (accent && !accent.startsWith('token:')) {
                // Primary is a token ref but accent is concrete — just write accent.
                themeUpdates.accentColor = hexToHsl(accent);
              }

              onApply(palette, themeUpdates);
              onClose();
            }}
            disabled={!palette}
            className="font-semibold"
          >
            {t('applyAll')}
          </Button>
        </div>
      </div>
    </div>
  );
}
