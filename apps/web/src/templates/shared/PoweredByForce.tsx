'use client';

import { useLanguage } from '../../contexts/LanguageContext';

/**
 * "Powered by Force AI" footer attribution. Rendered as the very last line
 * inside every theme's <footer>. Bilingual via the existing i18n key
 * "Powered by Force AI" -> "مدعوم من Force AI" (added to LanguageContext
 * 2026-05-16).
 *
 * Now an anchor linking to the Force Media marketing site. `rel="noopener
 * noreferrer"` because external + visited by anonymous customers; `target=
 * "_blank"` so it doesn't unload the merchant's storefront when clicked.
 *
 * Styling intentionally low-contrast (text-muted-foreground/70 + tiny
 * size) so it reads as platform attribution, not store branding.
 */
export function PoweredByForce() {
  const { t } = useLanguage();
  return (
    <div className="mt-6 border-t border-border/40 pt-4 text-center text-[11px] tracking-wide text-muted-foreground/70">
      <a
        href="https://forcemediakw.com"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-foreground/80 transition-colors"
      >
        {t('Powered by Force AI', 'مدعوم من Force AI')}
      </a>
    </div>
  );
}
