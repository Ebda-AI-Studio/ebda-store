'use client';

/**
 * The footer's legal row (S-01, quality-bar § 8): privacy · terms · returns · ©.
 *
 * Every skin footer (minimal, classic, modern, elegant, bold) and Dahab renders
 * it, so a shopper can always reach the store's own policy pages. The
 * per-link state comes from `resolveBottomBar` (the merchant's saved bottom-bar
 * toggles AND the CMS page's publish state — a page the merchant turned off
 * in /content drops its link), and the © line honours the merchant's
 * copyright override and the bar's `enabled` switch.
 *
 * A link the merchant already placed in a footer column is not repeated here
 * (one fact, one place). Hairline idiom. Each skin passes its own footer-link ink
 * as `className` (inheriting the body ink vanished on a dark merchant footer).
 */
import { useLanguage } from '../../contexts/LanguageContext';
import { useRenderNow } from '../../contexts/RenderClockContext';
import type { FooterLinksConfig } from '../types';
import { resolveBottomBar, resolveFooterSections } from './display-helpers';

export interface FooterLegalRowProps {
  footerLinks?: FooterLinksConfig;
  disabledCmsSlugs?: string[];
  /** The RTL-aware display name, for the default © line. */
  storeName: string;
  isRtl: boolean;
  /** The store's path prefix (`storeUrl('')`); empty on a custom domain. */
  urlPrefix?: string;
  /** Draw the top hairline (a skin whose bar already has one passes false). */
  hairline?: boolean;
  className?: string;
}

/** The path a footer href points at, for "is this link already in a column". */
function pathOf(href: string): string {
  try {
    return new URL(href, 'https://x.invalid').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return href;
  }
}

export function FooterLegalRow({
  footerLinks,
  disabledCmsSlugs,
  storeName,
  isRtl,
  urlPrefix = '',
  hairline = true,
  className,
}: FooterLegalRowProps) {
  const { t } = useLanguage();
  // UTC year of the per-request clock: getFullYear() is the local zone's, which differs between
  // the Worker (UTC) and a Cairo browser for 2 h a year and mismatched the hydrating render.
  const year = new Date(useRenderNow()).getUTCFullYear();
  const bar = resolveBottomBar(footerLinks?.bottomBar, storeName, isRtl, disabledCmsSlugs, year);
  if (!bar.enabled) return null;

  const inColumns = new Set(
    resolveFooterSections(footerLinks, isRtl).flatMap(s => s.links.map(l => pathOf(l.href)))
  );
  const links = [
    { on: bar.privacyEnabled, path: '/privacy', label: t('Privacy', 'الخصوصية') },
    { on: bar.termsEnabled, path: '/terms', label: t('Terms', 'الشروط والأحكام') },
    { on: bar.returnsEnabled, path: '/returns', label: t('Returns', 'الإرجاع') },
  ]
    .map(l => ({ ...l, href: `${urlPrefix}${l.path}` }))
    .filter(l => l.on && !inColumns.has(pathOf(l.href)));

  return (
    <div
      data-footer-legal=""
      className={[
        'flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between',
        hairline && 'border-t py-4',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      // A hairline in the footer's own ink (the inverted bold footer included).
      style={
        hairline ? { borderColor: 'color-mix(in srgb, currentColor 15%, transparent)' } : undefined
      }
    >
      {links.length > 0 && (
        <nav aria-label={t('Store policies', 'سياسات المتجر')}>
          <ul className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {links.map((l, i) => (
              <li key={l.path} className="flex items-center gap-x-2">
                {i > 0 && (
                  <span aria-hidden="true" className="opacity-60">
                    ·
                  </span>
                )}
                <a
                  href={l.href}
                  className="underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {bar.copyright && <p>{bar.copyright}</p>}
    </div>
  );
}
