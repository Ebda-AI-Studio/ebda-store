'use client';

import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ColorPalettePicker } from './ColorPalettePicker';
import { TypographyPicker } from './TypographyPicker';
import { BackgroundPresetPicker } from './BackgroundPresetPicker';
import type { StoreBranding } from './types';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
}

/**
 * Theme & colors tab: primary/secondary palette, typography, and a live preview.
 */
export function ThemeTab({ branding, onChange }: ThemeTabProps) {
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

      {/* Bucket C5 (2026-05-17) — opt-in brand pill on product cards. */}
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            {t('brandBadge.title')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('brandBadge.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showBrandBadge === true}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showBrandBadge: e.target.checked },
            })
          }
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      {/* Bucket E3 (2026-05-17) — opt-in quick-add (+) on carousel cards. */}
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground">{t('quickAdd.title')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('quickAdd.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showQuickAdd === true}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showQuickAdd: e.target.checked },
            })
          }
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

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

      {/* Homepage section toggles (2026-05-17 evening) — added after Ahmad
          asked "where to toggle this off" about the brand story block. */}
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            {t('brandStory.title')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('brandStory.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showBrandStory !== false}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showBrandStory: e.target.checked },
            })
          }
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            {t('trustStrip.title')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('trustStrip.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.theme.showTrustStrip !== false}
          onChange={e =>
            onChange({
              ...branding,
              theme: { ...branding.theme, showTrustStrip: e.target.checked },
            })
          }
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      {/* Trust-strip layout direction — radio pair (horizontal vs
          vertical). Only meaningful when showTrustStrip is on, so the
          control fades when the parent toggle is off. */}
      <div
        className={`rounded-lg border border-border bg-card p-4 transition-opacity ${
          branding.theme.showTrustStrip === false ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        <div className="mb-3">
          <p className="text-sm font-semibold text-foreground">{t('trustStripLayout.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('trustStripLayout.hint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['horizontal', 'vertical'] as const).map(opt => {
            const selected = (branding.theme.trustStripLayout ?? 'horizontal') === opt;
            return (
              <label
                key={opt}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm transition-colors ${
                  selected
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border text-muted-foreground hover:border-foreground/30'
                }`}
              >
                <input
                  type="radio"
                  checked={selected}
                  onChange={() =>
                    onChange({
                      ...branding,
                      theme: { ...branding.theme, trustStripLayout: opt },
                    })
                  }
                  className="sr-only"
                />
                {t(`trustStripLayout.${opt}`)}
              </label>
            );
          })}
        </div>
      </div>

      <BrandPreview theme={branding.theme} />
    </div>
  );
}
