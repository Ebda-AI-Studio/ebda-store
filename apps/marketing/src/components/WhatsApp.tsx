import { whatsappDisplay, whatsappUrl } from '@force/shared/brand';

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
 * The public WhatsApp line. The number is always real, selectable text (dir=ltr) beside the
 * wa.me link, never only an icon: people copy it into their own contacts.
 * `compact`: header form (icon + label; the number is hidden below the desktop breakpoint,
 * where it is repeated inside the menu).
 */
export function WhatsApp({
  label,
  ariaLabel,
  compact = false,
  showNumber = true,
}: {
  label: string;
  ariaLabel: string;
  compact?: boolean;
  showNumber?: boolean;
}) {
  const num = whatsappDisplay();
  return (
    <span className={`wa${compact ? ' wa-compact' : ''}`}>
      <a
        href={whatsappUrl()}
        className="wa-link"
        aria-label={`${ariaLabel} ${num}`}
        rel="noopener"
        data-whatsapp=""
      >
        <ChatIcon />
        <span className="wa-label">{label}</span>
      </a>
      {showNumber && (
        <span className="wa-num" dir="ltr" lang="en" translate="no">
          {num}
        </span>
      )}
    </span>
  );
}
