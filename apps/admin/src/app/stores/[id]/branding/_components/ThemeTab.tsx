'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { deriveCoreBrandTokens } from '@force/shared';
import { BrandPreview } from './BrandPreview';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { ColorField } from '../../../../../components/ColorField';
import { hexToHsl, hslToHex } from '../../../../../lib/color';
import type { StoreBranding, StoreTheme } from './types';
import type { StoreTheme as SharedStoreTheme } from '@force/shared';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  storeId: string;
}

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
 * become the color options the Page Builder reads. Fine-grained, per-section
 * color editing lives in the Page Builder; this tab is NOT a second editor.
 */
export function ThemeTab({ branding, onChange, storeId }: ThemeTabProps) {
  const t = useT('branding.theme');
  const tColors = useT('branding.theme.brandColors');

  const theme = branding.theme;
  const sharedTheme = asSharedTheme(theme);

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
            className="inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-4 py-2 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ✨ {tColors('generateButton')}
          </button>
          <Link
            href={`/stores/${storeId}/page-builder`}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {tColors('pageBuilderLink')} →
          </Link>
        </div>

        <BrandPreview theme={branding.theme} />
      </div>

      {/* ── Logo size ────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{t('logoSize.title')}</p>
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

      {/* ── Social icon brand colors ────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Social icon colors / ألوان أيقونات التواصل الاجتماعي
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            By default social icons inherit the footer&apos;s text color (monochrome). Enable
            original brand colors to show each platform in its registered color (Instagram pink,
            WhatsApp green, etc.).
          </p>
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
          <span className="text-xs text-foreground">
            Use original brand colors in footer social icons / استخدام ألوان العلامة التجارية
            الأصلية في أيقونات التواصل الاجتماعي بالتذييل
          </span>
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
          <span className="text-xs text-foreground">
            Use original brand colors in floating widget buttons (overrides custom button colors) /
            استخدام ألوان العلامة التجارية الأصلية في أزرار القطعة العائمة
          </span>
        </label>
      </div>

      {/* ── Storefront web push ───────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Storefront web push / إشعارات الويب للمتجر
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Off by default. When on, shoppers can subscribe to web push (requires the Push
            Notifications plan feature).
          </p>
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
          <span className="text-xs text-foreground">
            Enable storefront web push opt-in / تفعيل اشتراك إشعارات الويب في المتجر
          </span>
        </label>
      </div>

      {/* ── Persona chrome (2026-07-12) ──────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Persona chrome completion / إتمام هوية القالب
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Off by default on existing stores; new stores are created with this on. Adds
            theme-specific chrome using your existing colors: hairline-flanked heading + whisper
            see-all link on Elegant, circular category tiles on Classic, bordered header + inverted
            footer on Bold. No change to card sizes, product name/price text, fonts, or colors.
          </p>
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
          <span className="text-xs text-foreground">
            Enable persona chrome completion / تفعيل إتمام هوية القالب
          </span>
        </label>
      </div>

      {/* ── Card-frame dedup (2026-07-12) ────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Remove doubled card frame / إزالة الإطار المزدوج للبطاقات
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Off by default on existing stores; new stores are created with this on. When your
            homepage carousels/strips have "Show card frame" enabled, this removes the extra inner
            border so each card shows a single frame instead of two nested ones.
          </p>
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
          <span className="text-xs text-foreground">
            Enable single card frame / تفعيل إطار واحد للبطاقات
          </span>
        </label>
      </div>

      {/* ── Uppercase styling ─────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Uppercase text styling (nav, headings, labels) / نمط الأحرف الكبيرة
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When enabled, nav links, footer column headings, section headings, category captions,
            hero text, and testimonial author names render in uppercase. Off by default (natural
            case). Product names have their own control on Page Builder.
          </p>
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
          <span className="text-xs text-foreground">
            Enable uppercase chrome styling / تفعيل نمط الأحرف الكبيرة في الواجهة
          </span>
        </label>
      </div>

      {/* ── Arabic numerals ──────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('arabicNumerals.title')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('arabicNumerals.hint')}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={branding.theme.arabicNumerals === true}
            onChange={e =>
              onChange({
                ...branding,
                theme: { ...branding.theme, arabicNumerals: e.target.checked },
              })
            }
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-foreground">{t('arabicNumerals.title')}</span>
        </label>
      </div>

      {/* ── Footer logo ───────────────────────────────────────────────────── */}
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
    </div>
  );
}
