'use client';

import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ColorPalettePicker } from './ColorPalettePicker';
import { TypographyPicker } from './TypographyPicker';
import { BackgroundPresetPicker } from './BackgroundPresetPicker';
import { ImageUpload } from '../../../../../components/ImageUpload';
import type { StoreBranding } from './types';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  storeId: string;
}

/**
 * Theme & colors tab: primary/secondary palette, typography, and a live preview.
 */
export function ThemeTab({ branding, onChange, storeId }: ThemeTabProps) {
  const t = useT('branding.theme');

  return (
    <div className="bg-card rounded-xl border p-6 space-y-6">
      <ColorPalettePicker
        label={t('primaryColor')}
        hslValue={branding.theme.primaryColor}
        onChange={hsl => onChange({ ...branding, theme: { ...branding.theme, primaryColor: hsl } })}
        showPresets
        placeholder="#FF6600"
      />

      <ColorPalettePicker
        label={t('secondaryColor')}
        hslValue={branding.theme.secondaryColor}
        onChange={hsl =>
          onChange({ ...branding, theme: { ...branding.theme, secondaryColor: hsl } })
        }
        placeholder="#F3F4F6"
      />

      <TypographyPicker
        theme={branding.theme}
        onChange={theme => onChange({ ...branding, theme })}
      />

      {/* Sprint 1 (2026-05-17) — homepage section background preset.
          ADDITIVE: doesn't replace or remove any existing branding
          control. Defaults to 'none' so existing stores see no visual
          change until they explicitly pick a preset. */}
      <BackgroundPresetPicker
        theme={branding.theme}
        onChange={theme => onChange({ ...branding, theme })}
      />

      {/* Brand badge + Quick add card-level toggles REMOVED 2026-05-20:
          moved to Page Builder → Product Card Defaults section card.
          They affect every product card on the store, not just the
          theme-level visual identity, so they belong with the other
          catalog-wide product card controls. */}

      {/* Bucket E1 (2026-05-17) — opt-in blog feature toggle. Sits on the
          Theme tab alongside the other store-level on/off flags so the
          merchant has a single discovery surface. Storefront `/blog`
          routes 404 + homepage BlogCarousel hides when this is off. */}
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
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

      {/* Brand Story + Trust Strip enable/disable + Trust Strip layout/size
          REMOVED 2026-05-20: page-builder owns these per-section settings.
          Theme-tab versions were redundant. Storefront still honors
          theme.showBrandStory / showTrustStrip / trustStripLayout / size as
          legacy fallback for stores saved before the page-builder section
          landed (see TrustStrip.tsx + HomePageContent.tsx). */}

      {/* Footer-specific logo. Ahmad 2026-05-20: dark footer bgs need a
          white/inverted logo. Two paths: (a) upload a separate footer logo
          here, OR (b) toggle the invert filter on the main logo. The custom
          upload wins when both are set. */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
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
        <label className="flex items-center gap-2 cursor-pointer">
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
      </div>

      <BrandPreview theme={branding.theme} />
    </div>
  );
}
