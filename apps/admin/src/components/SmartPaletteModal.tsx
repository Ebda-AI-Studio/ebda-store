'use client';

import { useState } from 'react';
import { generateSectionPalette } from '@force/shared';
import type { StoreTheme, SectionKey, PaletteSeeds, SectionPaletteEntry } from '@force/shared';
import { ColorField } from './ColorField';

interface SmartPaletteModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (palette: Record<SectionKey, SectionPaletteEntry>) => void;
  theme: StoreTheme | undefined;
}

export function SmartPaletteModal({ open, onClose, onApply, theme }: SmartPaletteModalProps) {
  const [primary, setPrimary] = useState<string>('token:primary');
  const [accent, setAccent] = useState<string>('');
  const [neutral, setNeutral] = useState<string>('');

  if (!open) return null;

  const seeds: PaletteSeeds = {
    primary,
    accent: accent || undefined,
    neutral: neutral || undefined,
  };
  const palette = primary ? generateSectionPalette(seeds) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-6 shadow-2xl">
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

        {palette ? (
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Preview</h3>
            <div className="grid grid-cols-5 gap-2">
              {(['hero', 'categories', 'newArrivals', 'bestSellers', 'testimonials'] as const).map(
                key => (
                  <div
                    key={key}
                    className="aspect-[3/4] rounded-lg border-2 p-2 text-center text-[10px]"
                    style={{
                      backgroundColor: palette[key].bgColor.startsWith('token:')
                        ? '#eee'
                        : palette[key].bgColor,
                      borderColor: palette[key].cardFrameColor.startsWith('token:')
                        ? '#888'
                        : palette[key].cardFrameColor,
                      color:
                        palette[key].headingColor === 'auto' ? '#000' : palette[key].headingColor,
                    }}
                  >
                    <div className="font-semibold capitalize">{key}</div>
                  </div>
                )
              )}
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
