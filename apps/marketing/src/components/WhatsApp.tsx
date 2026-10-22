import { whatsappUrl } from '@ebda/shared/brand';
import type { Locale } from '../lib/site';
import { SiteLink } from './SiteLink';

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="wa-icon">
      <path
        d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M9.2 8.6c.2-.4.5-.4.7-.4l.5.1.8 1.8c0 .2 0 .4-.2.6l-.5.6c.6 1.1 1.5 2 2.6 2.6l.6-.6c.2-.2.4-.2.6-.1l1.7.8c.1.3.1.6 0 .9-.3.8-1.3 1.2-2.2 1-2.6-.7-4.5-2.6-5.2-5.2-.1-.6.1-1.5 1-2.1Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * The public WhatsApp line, as a button only (Ruling MKT-11): icon + label linking to wa.me.
 * The number is never written on the page; it lives in BRAND.contact.whatsapp and nowhere visible.
 * `compact`: header form; the label is hidden below the desktop breakpoint (icon-only, aria-label stays).
 */
export function WhatsApp({
  label,
  ariaLabel,
  locale,
  compact = false,
}: {
  label: string;
  ariaLabel: string;
  locale: Locale;
  compact?: boolean;
}) {
  return (
    <span className={`wa${compact ? ' wa-compact' : ''}`}>
      <SiteLink
        href={whatsappUrl()}
        locale={locale}
        className="wa-link"
        aria-label={ariaLabel}
        data-whatsapp=""
      >
        <ChatIcon />
        <span className="wa-label">{label}</span>
      </SiteLink>
    </span>
  );
}
