'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Surfaces the browser's install prompt as an in-app banner (Chrome/Android +
 * desktop Chrome fire `beforeinstallprompt`). iOS Safari has no programmatic
 * install — the manifest + apple-web-app meta make "Add to Home Screen" work
 * there natively, so this banner simply never shows on iOS.
 */
export function InstallPrompt() {
  const { t } = useLanguage();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (!deferred || dismissed) return null;

  return (
    <div className="mx-auto mb-3 flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <span className="text-sm font-medium text-foreground">{t.install.cta}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
          className="inline-flex h-11 min-w-[44px] items-center rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground active:opacity-80"
        >
          {t.install.cta}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="inline-flex h-11 min-w-[44px] items-center rounded-full border border-border px-3 text-xs font-medium text-muted-foreground active:bg-muted/60"
        >
          {t.install.dismiss}
        </button>
      </div>
    </div>
  );
}
