'use client';

import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { ColorField } from '../../../../../components/ColorField';
import { SmartPaletteModal } from '../../../../../components/SmartPaletteModal';
import type { StoreBranding, StoreTheme } from './types';
import type { StoreTheme as SharedStoreTheme } from '@force/shared';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  storeId: string;
}

/**
 * Cast the local StoreTheme (admin/branding types.ts) to the shared
 * StoreTheme for passing to ColorField and SmartPaletteModal.
 * The local type is a strict subset; casting is safe.
 */
function asSharedTheme(t: StoreTheme): SharedStoreTheme {
  return t as unknown as SharedStoreTheme;
}

/**
 * Update a single theme color key on the branding object (shallow merge).
 * Only the changed key is included in the update so the server-side
 * shallow-merge PUT doesn't clobber unrelated theme keys.
 */
function patchTheme(
  branding: StoreBranding,
  onChange: (b: StoreBranding) => void,
  key: keyof StoreTheme,
  value: string
) {
  onChange({
    ...branding,
    theme: { ...branding.theme, [key]: value },
  });
}

/**
 * Theme & colors tab. Exposes the core brand color tokens as individual
 * ColorFields (primary/secondary/accent/background/foreground/card/muted/border
 * + foreground overrides) so merchants can tune every color directly.
 * Smart Palette remains available as a generator that fills all fields.
 *
 * Footer logo options and blog toggle are also here.
 */
export function ThemeTab({ branding, onChange, storeId }: ThemeTabProps) {
  const t = useT('branding.theme');
  const tColors = useT('branding.theme.brandColors');

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [textColorsExpanded, setTextColorsExpanded] = useState(false);

  const theme = branding.theme;
  const sharedTheme = asSharedTheme(theme);

  return (
    <div className="space-y-6 rounded-xl border bg-card p-6">
      {/* ── Brand colors ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">{tColors('title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{tColors('hint')}</p>
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10"
          >
            ✨ {tColors('smartPaletteButton')}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <ColorField
            label={tColors('primary')}
            value={theme.primaryColor}
            onChange={v => patchTheme(branding, onChange, 'primaryColor', v)}
            hint={tColors('primaryHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('secondary')}
            value={theme.secondaryColor}
            onChange={v => patchTheme(branding, onChange, 'secondaryColor', v)}
            hint={tColors('secondaryHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('accent')}
            value={theme.accentColor}
            onChange={v => patchTheme(branding, onChange, 'accentColor', v)}
            hint={tColors('accentHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('background')}
            value={theme.backgroundColor}
            onChange={v => patchTheme(branding, onChange, 'backgroundColor', v)}
            hint={tColors('backgroundHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('foreground')}
            value={theme.foregroundColor}
            onChange={v => patchTheme(branding, onChange, 'foregroundColor', v)}
            hint={tColors('foregroundHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('card')}
            value={theme.cardColor}
            onChange={v => patchTheme(branding, onChange, 'cardColor', v)}
            hint={tColors('cardHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('muted')}
            value={theme.mutedColor}
            onChange={v => patchTheme(branding, onChange, 'mutedColor', v)}
            hint={tColors('mutedHint')}
            theme={sharedTheme}
          />
          <ColorField
            label={tColors('border')}
            value={theme.borderColor}
            onChange={v => patchTheme(branding, onChange, 'borderColor', v)}
            hint={tColors('borderHint')}
            theme={sharedTheme}
          />
        </div>

        {/* Collapsible text-colors subgroup */}
        <div className="rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setTextColorsExpanded(v => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/40"
            aria-expanded={textColorsExpanded}
          >
            <span>{tColors('textColors')}</span>
            <span className="text-muted-foreground">{textColorsExpanded ? '▲' : '▼'}</span>
          </button>
          {textColorsExpanded && (
            <div className="grid grid-cols-1 gap-1 border-t border-border px-4 pb-4 sm:grid-cols-2">
              <ColorField
                label={tColors('primaryForeground')}
                value={theme.primaryForeground}
                onChange={v => patchTheme(branding, onChange, 'primaryForeground', v)}
                hint={tColors('primaryForegroundHint')}
                theme={sharedTheme}
              />
              <ColorField
                label={tColors('secondaryForeground')}
                value={theme.secondaryForeground}
                onChange={v => patchTheme(branding, onChange, 'secondaryForeground', v)}
                hint={tColors('secondaryForegroundHint')}
                theme={sharedTheme}
              />
              <ColorField
                label={tColors('accentForeground')}
                value={theme.accentForeground}
                onChange={v => patchTheme(branding, onChange, 'accentForeground', v)}
                hint={tColors('accentForegroundHint')}
                theme={sharedTheme}
              />
              <ColorField
                label={tColors('cardForeground')}
                value={theme.cardForeground}
                onChange={v => patchTheme(branding, onChange, 'cardForeground', v)}
                hint={tColors('cardForegroundHint')}
                theme={sharedTheme}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Smart Palette modal ───────────────────────────────────────── */}
      <SmartPaletteModal
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={sharedTheme}
        storeId={storeId}
        onApply={(_palette, themeUpdates) => {
          // Merge all derived core brand token HSL values into the local
          // branding state. The parent's Save button commits them via the
          // shallow-merge PUT /stores/:id/theme.
          const { showBrandBadge: _sb, showQuickAdd: _sq, ...colorUpdates } = themeUpdates;
          onChange({
            ...branding,
            theme: { ...branding.theme, ...(colorUpdates as Partial<StoreTheme>) },
          });
          setPaletteOpen(false);
        }}
      />

      {/* ── Blog ─────────────────────────────────────────────────────── */}
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">{t('blog.title')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('blog.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.blogEnabled === true}
          onChange={e => onChange({ ...branding, blogEnabled: e.target.checked })}
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      {/* ── Footer logo ───────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Footer logo (optional)</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Upload a different logo for the footer when your footer background is dark and the main
            logo doesn&apos;t read well. Leave empty to use the main logo.
          </p>
        </div>
        <ImageUpload
          value={branding.theme.footerLogo}
          onUpload={url =>
            onChange({
              ...branding,
              theme: { ...branding.theme, footerLogo: url },
            })
          }
          onRemove={() =>
            onChange({
              ...branding,
              theme: { ...branding.theme, footerLogo: undefined },
            })
          }
          folder="logos"
          storeId={storeId}
          accept="image/*"
          label="Upload footer logo"
        />
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.footerLogoInvert === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, footerLogoInvert: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">
            Or invert the main logo to white (CSS filter — useful for dark footer backgrounds when
            uploading a separate logo isn&apos;t worth it). Ignored when a footer logo is uploaded
            above.
          </span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.hideFooterLogoMobile === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, hideFooterLogoMobile: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">
            Hide footer logo on mobile (desktop footer logo stays visible). Useful when the header
            logo on mobile is already large and the footer reads better as text-only.
          </span>
        </label>
      </div>

      <BrandPreview theme={branding.theme} />
    </div>
  );
}
