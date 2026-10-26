'use client';

/** Footer control to change the cookie choice later (consent must be as easy to withdraw as to give). */
export function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="link-button"
      onClick={() => void import('@/lib/tracker').then(m => m.getTracker()?.showBanner(true))}
    >
      {label}
    </button>
  );
}
