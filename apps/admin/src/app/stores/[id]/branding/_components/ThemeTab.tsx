'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { BrandPreview } from './BrandPreview';
import { ImageUpload } from '../../../../../components/ImageUpload';
import type { StoreBranding } from './types';

interface ThemeTabProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  storeId: string;
}

/**
 * A one-line "edit this in the Page Builder" pointer. The control it
 * replaces was retired here because the Page Builder (Smart Palette /
 * per-zone Typography / per-section background) is now the single editor
 * for that field — keeping a duplicate editor in Branding produced the
 * whole-theme clobber documented in the 2026-06-09 overlap audit. The
 * underlying theme field is preserved (the storefront still reads it);
 * only the duplicate EDITOR moved.
 */
function PageBuilderPointer({
  href,
  title,
  hint,
  link,
}: {
  href: string;
  title: string;
  hint: string;
  link: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-1.5">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Link
        href={href}
        className="inline-flex items-center text-xs font-semibold text-primary hover:underline"
      >
        {link}
      </Link>
    </div>
  );
}

/**
 * Theme & colors tab. The primary/secondary color pickers, font-family
 * picker and section-background preset were RETIRED here (2026-06-09):
 * the Page Builder's Smart Palette, per-zone Typography and per-section
 * background are the canonical editors. This tab now keeps only the
 * Branding-owned fields (blog toggle, footer logo) plus pointers into the
 * Page Builder for the moved controls, and a live preview.
 */
export function ThemeTab({ branding, onChange, storeId }: ThemeTabProps) {
  const t = useT('branding.theme');
  const pageBuilderHref = `/stores/${storeId}/page-builder`;

  return (
    <div className="bg-card rounded-xl border p-6 space-y-6">
      {/* Color tokens (primaryColor / secondaryColor / accentColor) are now
          owned by the Page Builder Smart Palette. Field preserved; editor
          moved. */}
      <PageBuilderPointer
        href={pageBuilderHref}
        title={t('pageBuilderPointer.colors.title')}
        hint={t('pageBuilderPointer.colors.hint')}
        link={t('pageBuilderPointer.colors.link')}
      />

      {/* Fonts (fontFamily / headingFontFamily) are now owned by the Page
          Builder's Fonts library + per-zone Typography (which emits
          font-family !important and wins on every tagged element). */}
      <PageBuilderPointer
        href={pageBuilderHref}
        title={t('pageBuilderPointer.fonts.title')}
        hint={t('pageBuilderPointer.fonts.hint')}
        link={t('pageBuilderPointer.fonts.link')}
      />

      {/* Per-section background (theme.backgroundPreset) is now owned by the
          Page Builder per-section bgColor controls. */}
      <PageBuilderPointer
        href={pageBuilderHref}
        title={t('pageBuilderPointer.background.title')}
        hint={t('pageBuilderPointer.background.hint')}
        link={t('pageBuilderPointer.background.link')}
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
        <label className="flex items-center gap-2 cursor-pointer">
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
