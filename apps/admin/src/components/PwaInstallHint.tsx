'use client';

/**
 * One-time hint banner that nudges admins to install the admin app to their
 * iPhone home screen. iOS Safari only grants Web Push permission to PWAs
 * that have been installed; without this step, OneSignal cannot deliver
 * order pings to iPhone users.
 *
 * Behavior:
 * - Hidden on non-iOS, when already running standalone (already installed),
 *   or after the user has dismissed it once.
 * - The dismissal is keyed in localStorage so it survives reloads but resets
 *   if the user clears site data — a fresh device should see the prompt.
 */

import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';

const DISMISSED_KEY = 'admin-pwa-install-dismissed';

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !('MSStream' in window);
  // Chrome on iOS uses CriOS; both pipe through WebKit so the install flow
  // is identical (Share → Add to Home Screen). We treat them the same.
  return isIos;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS uses navigator.standalone; Chrome/Edge use display-mode: standalone.
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function PwaInstallHint() {
  const t = useT('pwa.installHint');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIosSafari()) return;
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISSED_KEY)) return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label={t('title')}
      className="fixed bottom-4 left-4 right-4 z-[9999] mx-auto max-w-md rounded-lg border border-border bg-card p-4 shadow-xl"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary-ink">
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{t('title')}</p>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{t('description')}</p>
          <ol className="mt-2 list-decimal ps-5 text-xs text-muted-foreground space-y-0.5">
            <li>{t('step1')}</li>
            <li>{t('step2')}</li>
            <li>{t('step3')}</li>
          </ol>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t('dismiss')}
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, '1');
            setVisible(false);
          }}
          className="shrink-0 text-muted-foreground"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </Button>
      </div>
    </div>
  );
}
