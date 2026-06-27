'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useFeatures } from '../contexts/FeatureContext';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

const DISMISSED_KEY = 'push-dismissed';
const SUBSCRIBED_KEY = 'push-subscribed';

/**
 * Storefront push-notification subscribe prompt.
 *
 * Trigger model: NEVER auto-fires. The merchant complained that the
 * popup was appearing unprompted on first visit (which trains shoppers
 * to dismiss permission requests reflexively, hurting opt-in rates).
 * Now it only appears when something dispatches the
 * `force:open-push-prompt` window event — typically a bell-icon
 * button in the storefront header or a "Enable notifications" toggle
 * in account settings.
 *
 * Usage from anywhere in the storefront:
 *
 *   window.dispatchEvent(new Event('force:open-push-prompt'));
 *
 * Branding: the prompt now leads with the store's logo (RTL flips to
 * `logoAr` when present) so the merchant's identity is the first thing
 * the shopper sees, not a generic browser-style request.
 */
export function PushNotificationPrompt() {
  const { isEnabled } = useFeatures();
  const { store } = useStore();
  const { t, isRtl } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isEnabled('push_notifications')) return;
    // Merchant must explicitly opt in via Branding → Theme. Default false
    // so existing Professional stores get no push UI until they choose to.
    if (store?.theme?.storefrontWebPushEnabled !== true) return;
    if (typeof window === 'undefined') return;

    const handleOpen = () => {
      // Hard stops — don't reopen for users who already made a choice
      // or for browsers that can't handle push at all.
      if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return;
      if (localStorage.getItem(DISMISSED_KEY)) return;
      if (localStorage.getItem(SUBSCRIBED_KEY)) return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'default') return;
      setVisible(true);
    };

    window.addEventListener('force:open-push-prompt', handleOpen);
    return () => window.removeEventListener('force:open-push-prompt', handleOpen);
  }, [isEnabled, store?.theme?.storefrontWebPushEnabled]);

  if (!visible) return null;

  async function handleAccept() {
    setVisible(false);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? undefined,
      });

      await fetch(`/api/v1/public/${store.id}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });

      localStorage.setItem(SUBSCRIBED_KEY, '1');
    } catch {
      // Subscribe failed silently — push is an enhancement, not critical
    }
  }

  function handleDismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  }

  // Pick the locale-appropriate logo: prefer logoAr on RTL (Arabic wordmark),
  // fall back to the default logo, then the hero image as a last resort.
  const logo = (isRtl ? store?.logoAr : null) || store?.logo || store?.heroImage || null;
  const storeName = isRtl ? store.nameAr || store.name : store.name;

  // Bilingual alt text: already locale-aware via storeName (Arabic or English
  // per isRtl). The aria-label on the dialog handles the SR announce.
  const logoAlt = storeName
    ? t(`${storeName} logo`, `شعار ${storeName}`)
    : t('Store logo', 'شعار المتجر');

  // Lift above the mobile BottomTabBar (56px, fixed bottom-0) so this prompt
  // never overlaps / blocks the bar's tabs on mobile (rule 6: other fixed-bottom
  // UI lifts above the primary bar). Desktop has no bar → bottom-4 at md+.
  // Layout: vertical card — logo centred at top, title + subtitle below, then
  // action buttons, so the merchant's identity is the first thing the shopper
  // sees rather than a generic browser-style permission chrome.
  return (
    <div
      role="dialog"
      aria-label={t('Enable push notifications', 'تفعيل الإشعارات')}
      className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] md:bottom-4 left-1/2 z-[9999] flex w-[min(92vw,340px)] -translate-x-1/2 flex-col items-center rounded-2xl border border-border bg-card px-5 py-4 shadow-2xl text-center gap-1"
    >
      {/* Store logo centred at top — shrunk to a compact badge size */}
      {logo ? (
        <Image
          src={logo}
          alt={logoAlt}
          width={52}
          height={52}
          className="mb-1 h-[52px] w-[52px] rounded-xl object-contain bg-background"
          unoptimized
        />
      ) : (
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <svg
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
        </div>
      )}

      {/* Store name above subtitle */}
      <span className="text-sm font-semibold text-foreground leading-snug">
        {storeName || t('Push notifications', 'الإشعارات')}
      </span>
      <span className="text-xs text-muted-foreground leading-snug">
        {t('Enable notifications to get order updates', 'فعّل الإشعارات لتلقي تحديثات الطلبات')}
      </span>

      {/* Action buttons */}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleAccept}
          className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('Accept', 'السماح')}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('Dismiss notification prompt', 'تجاهل إشعار التنبيه')}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          {t('Dismiss', 'ليس الآن')}
        </button>
      </div>
    </div>
  );
}
