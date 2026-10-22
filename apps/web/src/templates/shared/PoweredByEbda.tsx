'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { BRAND, referralUrl } from '@ebda/shared';

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
 * Styling: muted (text-muted-foreground, AA on the footer surface) so it reads as platform
 * attribution not store branding. Size bumped from 11px to text-sm sm:text-base
 * (14-16px) 2026-05-17 evening — Ahmad reported the previous 11px was
 * unreadable. `data-zone="afterFooter"` lets the Typography admin override
 * size + family + color per-store (was missing — that's why admin font-size
 * changes weren't rendering). Tightened margin-top from mt-6 to mt-3 to
 * close the visible white-space gap above the credit on short footers.
 */
export function PoweredByEbda({ hidden = false }: { hidden?: boolean }) {
  const { t } = useLanguage();
  // Referral attribution: the link carries utm_source=ebda_store_badge and, as utm_content, the host of
  // the store that showed it, so a signup can be traced back to the storefront that sent it (the marketing
  // site keeps the UTMs as the first touch). The host is only known in the browser, so the first (server)
  // render uses the bare badge link and the host is added after mount, with no hydration mismatch.
  const [host, setHost] = useState('');
  useEffect(() => setHost(window.location.hostname), []);
  // Plan decision made server-side: the API resolves `remove_branding` from the
  // store's plan (Growth + Business) or a super-admin override and ships it in
  // `enabledFeatures`; ShopChrome turns that into this prop. Absent/unknown ->
  // keep the attribution (fail toward showing it).
  if (hidden) return null;
  return (
    <div
      data-zone="afterFooter"
      className={`mt-3 border-t border-border/40 pt-3 text-sm sm:text-base tracking-wide text-muted-foreground text-start`}
    >
      <a
        href={referralUrl('badge', host)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t(
          `Powered by ${t(BRAND.product.nameEn, BRAND.product.nameAr)}`,
          `مدعوم من ${BRAND.product.nameAr}`
        )}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 align-middle hover:opacity-80 transition-opacity"
      >
        {/* "Powered by Ebda" as a text wordmark. The wordmark is the footer's own ink + semibold:
            the brand gold (#B08D57) measured 3.09:1 on a white footer (STOP 1, Ruling B1-27), and
            the line is the full muted tone (the old /70 alpha also fell under 4.5:1). On a
            merchant-coloured footer both take the shared footer ink ([data-footer-ink], footer-ink.ts). */}
        <span>{t('Powered by', 'مدعوم من')}</span>
        {/* IA-09 (W4): attribution never outweighs the store's own name: one muted weight. */}
        <span className="font-medium">{t(BRAND.product.nameEn, BRAND.product.nameAr)}</span>
      </a>
    </div>
  );
}
