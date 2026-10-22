'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { deriveCoreBrandTokens } from '@ebda/shared';
import { BrandPreview } from './BrandPreview';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { ColorField } from '../../../../../components/ColorField';
import { hexToHsl, hslToHex } from '../../../../../lib/color';
import type { StoreBranding, StoreTheme } from './types';
import type { StoreTheme as SharedStoreTheme } from '@ebda/shared';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  storeId: string;
}

/** The skins that read `theme.personaChromeV2` (`git grep personaChromeV2 apps/web/src`). */
export const PERSONA_CHROME_SKINS: readonly string[] = ['bold', 'classic', 'elegant'];

/**
 * Cast the local StoreTheme (admin/branding types.ts) to the shared StoreTheme
 * for passing to ColorField. The local type is a strict subset; casting is safe.
 */
function asSharedTheme(t: StoreTheme): SharedStoreTheme {
  return t as unknown as SharedStoreTheme;
}

/** Return true when the string looks like a usable concrete hex or HSL color. */
function isUsableColor(v: string | undefined): v is string {
  if (!v || v.trim() === '') return false;
  const s = v.trim();
  return s.startsWith('#') || /^\d/.test(s) || s.startsWith('hsl(');
}

/**
 * Brand color tokens are stored as Tailwind HSL triplets ("H S% L%") because the
 * storefront consumes them via `hsl(var(--token))`. ColorField, however, speaks
 * hex. These two helpers bridge the gap so the picker shows a real swatch AND the
 * saved value stays a valid triplet (a raw hex would make `hsl(#xxxxxx)` and the
 * browser would drop the color — the cause of the "everything went black" bug).
 */
function tripletToHexForPicker(stored: string | undefined): string {
  if (!stored || stored.trim() === '') return '';
  const s = stored.trim();
  if (s.startsWith('#') || s.startsWith('token:')) return s; // already picker-friendly
  return hslToHex(s); // "H S% L%" → "#rrggbb"
}
function pickerValueToStored(fromField: string): string {
  if (!fromField) return '';
  if (fromField.startsWith('token:')) return fromField;
  if (fromField.startsWith('#')) return hexToHsl(fromField); // "#rrggbb" → "H S% L%"
  return fromField; // already a triplet
}

/**
 * A ColorField whose stored value is a Tailwind HSL triplet. Displays as hex,
 * saves as a triplet.
 */
function BrandColorField({
  label,
  hint,
  stored,
  onStore,
  theme,
}: {
  label: string;
  hint?: string;
  stored: string | undefined;
  onStore: (v: string) => void;
  theme: SharedStoreTheme;
}) {
  return (
    <ColorField
      label={label}
      hint={hint}
      theme={theme}
      value={tripletToHexForPicker(stored)}
      onChange={v => onStore(pickerValueToStored(v))}
    />
  );
}

/**
 * Theme & colors tab.
 *
 * Intentionally minimal: the merchant sets 2–3 brand SEED colors (Primary,
 * Secondary, optional Accent) and clicks "Generate palette". From those seeds we
 * derive the full token set (accent if unset, text, surfaces, borders, and the
 * two alternating page backgrounds) and save them onto the theme — where they
 * become the color options the visual editor reads. Fine-grained, per-section
 * color editing lives in the visual editor; this tab is NOT a second editor.
 */
export function ThemeTab({ branding, onChange, storeId }: ThemeTabProps) {
  const t = useT('branding.theme');
  const tColors = useT('branding.theme.brandColors');

  const theme = branding.theme;
  const sharedTheme = asSharedTheme(theme);
  // Only the skins whose renderers read `personaChromeV2` offer it (Ruling EP-1): bold's header and
  // footer, classic's category grid, elegant's section headings. A store whose template is not
  // known keeps the control (never hide on missing evidence).
  const showPersonaChrome = !branding.template || PERSONA_CHROME_SKINS.includes(branding.template);

  function setSeed(key: keyof StoreTheme, value: string) {
    onChange({ ...branding, theme: { ...branding.theme, [key]: value } });
  }

  const canGenerate = isUsableColor(theme.primaryColor) && isUsableColor(theme.secondaryColor);

  /** Derive the full palette from the seeds and write it onto the theme. */
  function generatePalette() {
    if (!canGenerate) return;
    const derived = deriveCoreBrandTokens({
      primary: theme.primaryColor,
      secondary: theme.secondaryColor,
    });
    onChange({
      ...branding,
      theme: {
        ...branding.theme,
        // Accent is an optional seed: keep the merchant's value if they set one,
        // otherwise use the auto-generated accent.
        accentColor: isUsableColor(theme.accentColor) ? theme.accentColor : derived.accentColor,
        backgroundColor: derived.backgroundColor,
        foregroundColor: derived.foregroundColor,
        cardColor: derived.cardColor,
        cardForeground: derived.cardForeground,
        mutedColor: derived.mutedColor,
        mutedForeground: derived.mutedForeground,
        borderColor: derived.borderColor,
        // Form fields draw with --input (quality bar K-05); the palette keeps it on its hairline
        // so a palette store's fields keep the colour they had before the sweep (B1-43).
        inputColor: derived.inputColor,
        primaryForeground: derived.primaryForeground,
        secondaryForeground: derived.secondaryForeground,
        accentForeground: derived.accentForeground,
        bgPage: derived.bgPage,
        bgSectionAlt: derived.bgSectionAlt,
      },
    });
  }

  return (
    <div className="space-y-6 rounded-xl border bg-card p-6">
      {/* ── Brand colors (seeds only) ────────────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold text-foreground">{tColors('title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{tColors('hint')}</p>
        </div>

        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <BrandColorField
            label={tColors('primary')}
            stored={theme.primaryColor}
            onStore={v => setSeed('primaryColor', v)}
            hint={tColors('primaryHint')}
            theme={sharedTheme}
          />
          <BrandColorField
            label={tColors('secondary')}
            stored={theme.secondaryColor}
            onStore={v => setSeed('secondaryColor', v)}
            hint={tColors('secondaryHint')}
            theme={sharedTheme}
          />
          <BrandColorField
            label={tColors('accent')}
            stored={theme.accentColor}
            onStore={v => setSeed('accentColor', v)}
            hint={tColors('accentOptionalHint')}
            theme={sharedTheme}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={generatePalette}
            disabled={!canGenerate}
            className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2 text-xs font-medium text-primary-ink hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ✨ {tColors('generateButton')}
          </button>
          <Link
            href={`/stores/${storeId}/builder`}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {tColors('editorLink')} →
          </Link>
        </div>

        <BrandPreview theme={branding.theme} />
      </div>

      {/* ── Logo size ────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p data-setting-id="branding.logo-size" className="text-sm font-semibold text-foreground">
          {t('logoSize.title')}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('logoSize.hint')}</p>
        <div className="mt-3 inline-flex rounded-lg border border-border p-0.5">
          {(['auto', 'sm', 'md', 'lg'] as const).map(opt => {
            const active = (theme.logoSize ?? 'auto') === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setSeed('logoSize', opt)}
                className={`min-w-[44px] rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {t(`logoSize.${opt}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Blog ─────────────────────────────────────────────────────────── */}
      <label
        data-theme-toggle="blog"
        className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card p-4"
      >
        <span className="min-w-0 flex-1">
          <span
            data-setting-id="branding.blog"
            className="block text-sm font-semibold text-foreground"
          >
            {t('blog.title')}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('blog.hint')}</span>
        </span>
        <input
          type="checkbox"
          checked={branding.blogEnabled === true}
          onChange={e => onChange({ ...branding, blogEnabled: e.target.checked })}
          className="h-5 w-5 cursor-pointer accent-primary"
        />
      </label>

      {/* ── Social icon brand colors ────────────────────────────────────── */}
      <div
        data-theme-toggle="social-icon-colors"
        className="space-y-3 rounded-lg border border-border bg-card p-4"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">{t('socialIconColors.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('socialIconColors.hint')}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.footerSocialOriginalColor === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, footerSocialOriginalColor: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('socialIconColors.footerLabel')}</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.floatingWidgetOriginalColor === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, floatingWidgetOriginalColor: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('socialIconColors.widgetLabel')}</span>
        </label>
      </div>

      {/* ── Storefront web push ───────────────────────────────────────────── */}
      <div
        data-theme-toggle="web-push"
        className="space-y-3 rounded-lg border border-border bg-card p-4"
      >
        <div>
          <p data-setting-id="branding.web-push" className="text-sm font-semibold text-foreground">
            {t('webPush.title')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('webPush.hint')}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.storefrontWebPushEnabled === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, storefrontWebPushEnabled: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('webPush.enableLabel')}</span>
        </label>
      </div>

      {/* ── Persona chrome (2026-07-12) ──────────────────────────────────── */}
      {showPersonaChrome && (
        <div
          data-theme-toggle="persona-chrome"
          className="space-y-3 rounded-lg border border-border bg-card p-4"
        >
          <div>
            <p className="text-sm font-semibold text-foreground">{t('personaChrome.title')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('personaChrome.hint')}</p>
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={branding.theme.personaChromeV2 === true}
              onChange={e =>
                onChange({
                  ...branding,
                  theme: { ...branding.theme, personaChromeV2: e.target.checked },
                })
              }
              className="h-4 w-4 cursor-pointer accent-primary"
            />
            <span className="text-xs text-foreground">{t('personaChrome.enableLabel')}</span>
          </label>
        </div>
      )}

      {/* ── Card-frame dedup (2026-07-12) ────────────────────────────────── */}
      <div
        data-theme-toggle="card-frame-dedup"
        className="space-y-3 rounded-lg border border-border bg-card p-4"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">{t('cardFrameDedup.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('cardFrameDedup.hint')}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.frameChromeDedup === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, frameChromeDedup: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('cardFrameDedup.enableLabel')}</span>
        </label>
      </div>

      {/* ── Uppercase styling ─────────────────────────────────────────────── */}
      <div
        data-theme-toggle="uppercase"
        className="space-y-3 rounded-lg border border-border bg-card p-4"
      >
        <div>
          <p className="text-sm font-semibold text-foreground">{t('uppercaseStyle.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('uppercaseStyle.hint')}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.uppercaseStyle === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, uppercaseStyle: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('uppercaseStyle.enableLabel')}</span>
        </label>
      </div>

      {/* ── Store numerals (Ruling NUMERALS-1) ─────────────────────────────
          Western 123 is the default in both languages; ١٢٣ is the store's
          opt-in for its Arabic customer-facing pages. The admin itself always
          shows 0-9. */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p
            data-setting-id="branding.arabic-numerals"
            id="store-numerals-label"
            className="text-sm font-semibold text-foreground"
          >
            {t('arabicNumerals.title')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('arabicNumerals.hint')}</p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="store-numerals-label"
          className="inline-flex overflow-hidden rounded-md border border-border"
        >
          {(
            [
              { arab: false, sample: '123', label: t('arabicNumerals.western') },
              { arab: true, sample: '١٢٣', label: t('arabicNumerals.arabic') },
            ] as const
          ).map(opt => {
            const selected = (branding.theme.arabicNumerals === true) === opt.arab;
            return (
              <button
                key={opt.sample}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={opt.label}
                onClick={() =>
                  onChange({
                    ...branding,
                    theme: { ...branding.theme, arabicNumerals: opt.arab },
                  })
                }
                className={`min-w-[4rem] px-4 py-2 text-sm tabular-nums transition-colors ${
                  selected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-foreground hover:bg-muted'
                }`}
              >
                {opt.sample}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Footer logo ───────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p
            data-setting-id="branding.footer-logo"
            className="text-sm font-semibold text-foreground"
          >
            {t('footerLogo.title')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('footerLogo.hint')}</p>
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
          label={t('footerLogoLabel')}
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
          <span className="text-xs text-foreground">{t('footerLogo.invertLabel')}</span>
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
          <span className="text-xs text-foreground">{t('footerLogo.hideMobileLabel')}</span>
        </label>
      </div>
    </div>
  );
}
