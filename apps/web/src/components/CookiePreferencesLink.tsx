'use client';

import { useConsent } from '../contexts/ConsentContext';
import { useLanguage } from '../contexts/LanguageContext';

interface CookiePreferencesLinkProps {
  className?: string;
}

/**
 * Footer link that re-opens the cookie preferences modal. Lets visitors
 * who already made a decision change their mind later. Required by
 * GDPR Art. 7(3) — withdrawing consent must be as easy as giving it.
 *
 * Renders a `<button>` not a `<Link>` so we don't navigate. Templates
 * pass their existing footer-link classes via `className` so the link
 * blends visually with siblings (Privacy, Terms, Shipping).
 */
export function CookiePreferencesLink({ className = '' }: CookiePreferencesLinkProps) {
  const { openPreferences } = useConsent();
  const { t } = useLanguage();
  return (
    <button type="button" onClick={openPreferences} className={className}>
      {t('Cookie preferences', 'تفضيلات ملفات تعريف الارتباط')}
    </button>
  );
}
