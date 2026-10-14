'use client';

import { getTracker } from '@/lib/tracker';

/** Footer control to change the cookie choice later (consent must be as easy to withdraw as to give). */
export function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button type="button" className="link-button" onClick={() => getTracker()?.showBanner(true)}>
      {label}
    </button>
  );
}
