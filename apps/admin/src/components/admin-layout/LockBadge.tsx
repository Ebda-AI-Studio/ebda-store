'use client';

import { useT } from '@/i18n/useT';

/** A small padlock on a navigation item whose feature the store's plan does not include (the page shows the upgrade card). */
export function LockBadge() {
  const t = useT('components.planLocked');
  return (
    <span
      role="img"
      aria-label={t('lockedAria')}
      title={t('lockedAria')}
      className="ms-1.5 inline-flex shrink-0 text-muted-ink"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
          clipRule="evenodd"
        />
      </svg>
    </span>
  );
}
