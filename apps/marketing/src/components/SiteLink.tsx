import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { BRAND } from '@ebda/shared/brand';
import type { Locale } from '../lib/site';

/** Hidden note after the link text (and in an aria-label) for every link that opens a new tab. */
export const NEW_TAB_NOTE: Record<Locale, string> = {
  ar: 'بيفتح في تبويب جديد',
  en: 'opens in a new tab',
};

const OWN_HOSTS = new Set([BRAND.domains.marketing, `www.${BRAND.domains.marketing}`]);

/**
 * True when `href` leaves the marketing site: an absolute http(s) (or protocol-relative) URL whose
 * host is not ebda.app itself. Paths, anchors, mailto: and tel: stay with the page.
 */
export function isExternalHref(href: string): boolean {
  if (!/^(https?:)?\/\//i.test(href)) return false;
  try {
    return !OWN_HOSTS.has(new URL(href, 'https://placeholder.invalid').hostname.toLowerCase());
  } catch {
    return true;
  }
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  href: string;
  locale: Locale;
  children: ReactNode;
};

/**
 * The one anchor for links that may leave the site: it decides by host. An external link opens in
 * a new tab (`target="_blank" rel="noopener noreferrer"`) and says so to assistive tech; an ebda.app
 * link renders as a plain same-tab anchor.
 */
export function SiteLink({ href, locale, children, 'aria-label': ariaLabel, ...rest }: Props) {
  if (!isExternalHref(href)) {
    return (
      <a href={href} aria-label={ariaLabel} {...rest}>
        {children}
      </a>
    );
  }
  const note = NEW_TAB_NOTE[locale];
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel ? `${ariaLabel} (${note})` : undefined}
      {...rest}
    >
      {children}
      <span className="sr-only"> ({note})</span>
    </a>
  );
}
