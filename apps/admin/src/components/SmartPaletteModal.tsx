'use client';

import { useState, useEffect } from 'react';
import {
  generateSectionPalette,
  DEFAULT_THEME,
  getTemplatePresets,
  getVibePreset,
} from '@force/shared';
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
} from '@force/shared';
import { hexToHsl } from '../lib/color';
import { ColorField } from './ColorField';
import { SectionPreview } from './SectionPreview';
import { apiPost } from '../lib/api';

/**
 * Brand-color updates the parent should persist to StoreTheme on apply.
 * Only populated when the merchant explicitly typed/picked a raw hex value —
 * if they selected an existing token ('token:primary') no theme update is needed.
 */
export interface ThemeUpdates {
  primaryColor?: string;
  accentColor?: string;
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

const PATTERN_LABELS: Record<PalettePattern, string> = {
  alternating: 'Alternating',
  monochrome: 'Monochrome (shaded)',
  triad: 'Triad',
  'single-bg': 'Solid background',
};

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
      setLogoError('Store ID not available.');
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
          setLogoError('Upload a store logo first.');
        } else if (code === 'AI_QUOTA_EXCEEDED' || code === 'AI_QUOTA_DAILY_EXCEEDED') {
          setLogoError('AI quota reached. Try again tomorrow.');
        } else {
          setLogoError(res.error.message ?? 'AI extraction failed.');
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
      setLogoError('AI extraction failed. Please try again.');
    } finally {
      setLogoLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground">Smart palette</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick 1–3 colors and we&apos;ll distribute them across every section&apos;s background,
          card frame, and heading color. Section text auto-fixes for contrast.
        </p>

        {/* Layer C: AI logo suggestion button */}
        <div className="mb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleLogoSuggest}
            disabled={logoLoading || !storeId}
            className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {logoLoading ? (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <span>✨</span>
            )}
            {logoLoading ? 'Extracting…' : 'Suggest from my logo'}
          </button>
          {logoError ? (
            <span className="text-xs text-destructive">{logoError}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Uses Gemini Vision to read dominant brand colors from your store logo
            </span>
          )}
        </div>

        {/* Layer B: Vibe picker */}
        <div className="mb-4 rounded-xl border border-border bg-muted/30 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Vibe (optional — overrides seeds + distribution)
          </h3>
          <div className="flex flex-wrap gap-2">
            {VIBE_IDS.map(vibeId => {
              const vibe = {
                luxury: 'Luxury',
                boutique: 'Boutique',
                grocery: 'Grocery',
                streetwear: 'Streetwear',
                minimal: 'Minimal',
                tech: 'Tech',
                restaurant: 'Restaurant',
                cafe: 'Cafe',
                beauty: 'Beauty',
              }[vibeId];
              return (
                <button
                  key={vibeId}
                  type="button"
                  onClick={() => applyVibe(vibeId)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    activeVibe === vibeId
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {vibe}
                </button>
              );
            })}
          </div>
        </div>

        {/* Distribution sub-section: pattern + frame thickness */}
        <div className="mb-4 rounded-xl border border-border bg-muted/30 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Distribution
          </h3>
          <div className="mb-3">
            <label className="mb-2 block text-xs font-medium text-muted-foreground">Pattern</label>
            <div className="grid grid-cols-4 gap-2">
              {(['alternating', 'monochrome', 'triad', 'single-bg'] as const).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPattern(p)}
                  className={`rounded border p-2 text-xs font-medium ${
                    pattern === p
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {PATTERN_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              Card frame thickness
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['thin', 'normal', 'thick', 'xthick'] as const).map(w => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setPaletteFrameWidth(w)}
                  className={`rounded border p-2 text-xs font-medium capitalize ${
                    paletteFrameWidth === w
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              Frame size (padding)
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['compact', 'normal', 'comfortable', 'spacious'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPaletteFrameSize(s)}
                  className={`rounded border p-2 text-xs font-medium capitalize ${
                    paletteFrameSize === s
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Seed color inputs + Layer A reset link */}
        <div className="space-y-3">
          <ColorField
            label="Primary (required)"
            value={primary}
            onChange={setPrimary}
            theme={theme}
          />
          <ColorField
            label="Accent (optional — fills one alternating slot)"
            value={accent}
            onChange={setAccent}
            theme={theme}
          />
          <ColorField
            label="Neutral (optional — defaults to white)"
            value={neutral}
            onChange={setNeutral}
            theme={theme}
          />
          {/* Layer A: reset link — only shown when template has a preset */}
          {getTemplatePresets(storeTemplate) ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={resetToTemplateDefaults}
                className="text-xs text-muted-foreground underline hover:text-foreground"
              >
                Reset to template defaults
              </button>
            </div>
          ) : null}
        </div>

        {/* Interactive preview grid — click any section to override */}
        {palette ? (
          <div className="mt-6">
            <p className="mb-2 text-xs text-muted-foreground">
              Preview shows pattern + frame thickness · Click a tile to override that section
            </p>
            <div className="grid grid-cols-5 gap-2">
              {SECTION_KEYS.map(key => (
                <div key={key} className="min-h-[180px]">
                  <button
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
                      label={key.charAt(0).toUpperCase() + key.slice(1)}
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
                    Override: {expandedSection.charAt(0).toUpperCase() + expandedSection.slice(1)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedSection(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    aria-label="Close override editor"
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ColorField
                    label="Background"
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
                    label="Card frame"
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
                    <span className="text-muted-foreground">Frame thickness</span>
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
                      className="rounded border border-border bg-background px-2 py-1 text-sm"
                    >
                      <option value="thin">Thin (1px)</option>
                      <option value="normal">Normal (2px)</option>
                      <option value="thick">Thick (4px)</option>
                      <option value="xthick">Extra thick (8px)</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setOverrides(prev => {
                      const next = { ...prev };
                      delete next[expandedSection];
                      return next;
                    })
                  }
                  className="mt-3 text-xs text-muted-foreground underline hover:text-foreground"
                >
                  Reset this section
                </button>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              Token refs (e.g. <code>token:primary</code>) preview as gray here; storefront resolves
              at render.
            </p>
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!palette) return;
              if (!confirm('This overwrites the current section bg + frame colors. Proceed?'))
                return;

              // Build theme updates: only include when the merchant entered a
              // raw hex value (not a token ref). Convert hex → HSL triplet to
              // match the format StoreTheme stores (e.g. '26 100% 50%').
              const themeUpdates: ThemeUpdates = {};
              if (primary && !primary.startsWith('token:')) {
                themeUpdates.primaryColor = hexToHsl(primary);
              }
              if (accent && !accent.startsWith('token:')) {
                themeUpdates.accentColor = hexToHsl(accent);
              }

              onApply(palette, themeUpdates);
              onClose();
            }}
            disabled={!palette}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            Apply to all sections
          </button>
        </div>
      </div>
    </div>
  );
}
