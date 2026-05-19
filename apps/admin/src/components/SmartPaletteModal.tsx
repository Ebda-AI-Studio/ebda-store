'use client';

import { useState } from 'react';
import { generateSectionPalette, DEFAULT_THEME } from '@force/shared';
import type {
  StoreTheme,
  SectionKey,
  PaletteSeeds,
  SectionPaletteEntry,
  PalettePattern,
  CardFrameSize,
  CardFrameWidth,
} from '@force/shared';
import { ColorField } from './ColorField';
import { SectionPreview } from './SectionPreview';

interface SmartPaletteModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (palette: Record<SectionKey, SectionPaletteEntry>) => void;
  theme: StoreTheme | undefined;
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

export function SmartPaletteModal({ open, onClose, onApply, theme }: SmartPaletteModalProps) {
  const [primary, setPrimary] = useState<string>('token:primary');
  const [accent, setAccent] = useState<string>('');
  const [neutral, setNeutral] = useState<string>('');
  const [pattern, setPattern] = useState<PalettePattern>('alternating');
  const [paletteFrameWidth, setPaletteFrameWidth] = useState<CardFrameWidth>('normal');
  const [paletteFrameSize, setPaletteFrameSize] = useState<CardFrameSize>('normal');
  const [overrides, setOverrides] = useState<
    Partial<Record<SectionKey, Partial<SectionPaletteEntry>>>
  >({});
  const [expandedSection, setExpandedSection] = useState<SectionKey | null>(null);

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

        {/* Seed color inputs */}
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
        </div>

        {/* Interactive preview grid — click any section to override */}
        {palette ? (
          <div className="mt-6">
            <p className="mb-2 text-xs text-muted-foreground">
              Preview shows pattern + frame thickness · Click a tile to override that section
            </p>
            <div className="grid grid-cols-5 gap-2">
              {SECTION_KEYS.map(key => (
                <div key={key}>
                  <div className="min-h-[180px]">
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
                  {expandedSection === key ? (
                    <div className="mt-2 space-y-2 rounded-lg border border-primary/40 bg-muted/30 p-2">
                      <ColorField
                        label="Background"
                        value={overrides[key]?.bgColor}
                        onChange={v =>
                          setOverrides(prev => ({ ...prev, [key]: { ...prev[key], bgColor: v } }))
                        }
                        theme={theme}
                        inheritFromToken="card"
                      />
                      <ColorField
                        label="Card frame"
                        value={overrides[key]?.cardFrameColor}
                        onChange={v =>
                          setOverrides(prev => ({
                            ...prev,
                            [key]: { ...prev[key], cardFrameColor: v },
                          }))
                        }
                        theme={theme}
                        inheritFromToken="border"
                      />
                      <div>
                        <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Frame thickness
                        </label>
                        <select
                          value={overrides[key]?.cardFrameWidth ?? palette[key].cardFrameWidth}
                          onChange={e =>
                            setOverrides(prev => ({
                              ...prev,
                              [key]: {
                                ...prev[key],
                                cardFrameWidth: e.target.value as CardFrameWidth,
                              },
                            }))
                          }
                          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                        >
                          <option value="thin">Thin (1px)</option>
                          <option value="normal">Normal (2px)</option>
                          <option value="thick">Thick (4px)</option>
                          <option value="xthick">Extra thick (8px)</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setOverrides(prev => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          })
                        }
                        className="text-xs text-muted-foreground underline"
                      >
                        Reset this section
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
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
              onApply(palette);
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
