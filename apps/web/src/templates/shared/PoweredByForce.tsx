'use client';

import { useLanguage } from '../../contexts/LanguageContext';
import { BRAND, BRAND_MARKETING_URL } from '@force/shared';

/**
 * "Powered by Ebda" footer attribution. Rendered as the very last line
 * inside every theme's <footer>. Bilingual via the existing i18n key
 * "Powered by Ebda" -> "مدعوم من ابدأ" (added to LanguageContext
 * 2026-05-16).
 *
 * Now an anchor linking to the Ebda website. `rel="noopener
 * noreferrer"` because external + visited by anonymous customers; `target=
 * "_blank"` so it doesn't unload the merchant's storefront when clicked.
 *
 * Styling: low-contrast (text-muted-foreground/70) so it reads as platform
 * attribution not store branding. Size bumped from 11px to text-sm sm:text-base
 * (14-16px) 2026-05-17 evening — Ahmad reported the previous 11px was
 * unreadable. `data-zone="afterFooter"` lets the Typography admin override
 * size + family + color per-store (was missing — that's why admin font-size
 * changes weren't rendering). Tightened margin-top from mt-6 to mt-3 to
 * close the visible white-space gap above the credit on short footers.
 */
export function PoweredByForce() {
  const { t, language } = useLanguage();
  const align = language === 'ar' ? 'text-right' : 'text-left';
  return (
    <div
      data-zone="afterFooter"
      className={`mt-3 border-t border-border/40 pt-3 text-sm sm:text-base tracking-wide text-muted-foreground/70 ${align}`}
    >
      <a
        href={BRAND_MARKETING_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t(`Powered by ${BRAND.name}`, `مدعوم من ${BRAND.nameAr}`)}
        className="inline-flex items-center gap-1 align-middle hover:opacity-80 transition-opacity"
      >
        {/* "Powered by Ebda" as a text wordmark — the raw /logo.svg mark read
            as a stray orange box in the footer. "Ebda" is set in the brand
            gold + semibold so it reads as an intentional wordmark, while
            "Powered by" stays muted (inherited) so it reads as attribution. */}
        <span>{t('Powered by', 'مدعوم من')}</span>
        <span className="font-semibold" style={{ color: BRAND.colors.gold }}>
          {BRAND.name}
        </span>
      </a>
    </div>
  );
}
