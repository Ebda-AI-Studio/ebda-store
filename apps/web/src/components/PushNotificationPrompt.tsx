'use client';

import { useEffect, useState } from 'react';
import { useFeatures } from '../contexts/FeatureContext';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';

const DISMISSED_KEY = 'push-dismissed';
const SUBSCRIBED_KEY = 'push-subscribed';
const SESSION_SEEN_KEY = 'push-seen-this-session';

export function PushNotificationPrompt() {
  const { isEnabled } = useFeatures();
  const { store } = useStore();
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Feature guard
    if (!isEnabled('push_notifications')) return;

    // Push won't work without a VAPID key — don't nag the user
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return;

    // Already dismissed permanently
    if (localStorage.getItem(DISMISSED_KEY)) return;

    // Already subscribed
    if (localStorage.getItem(SUBSCRIBED_KEY)) return;

    // Already shown this session — don't pop up on every navigation
    if (sessionStorage.getItem(SESSION_SEEN_KEY)) return;

    // Browser support check
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    // Permission already granted/denied means OS-level decision was made already
    if (Notification.permission !== 'default') return;

    // Check if already subscribed via SW registration
    navigator.serviceWorker.ready
      .then(registration => registration.pushManager.getSubscription())
      .then(subscription => {
        if (!subscription) {
          sessionStorage.setItem(SESSION_SEEN_KEY, '1');
          setVisible(true);
        }
      })
      .catch(() => {
        // SW not ready — silently skip rather than showing a broken prompt
      });
  }, [isEnabled]);

  if (!visible) return null;

  async function handleAccept() {
    setVisible(false);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // VAPID public key would normally come from env — use a placeholder if not set
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

  return (
    <div
      role="dialog"
      aria-label={t('Enable push notifications', 'تفعيل الإشعارات')}
      style={{
        position: 'fixed',
        bottom: '1rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.75rem 1rem',
        background: 'hsl(var(--card))',
        color: 'hsl(var(--card-foreground))',
        border: '1px solid hsl(var(--border))',
        borderRadius: '0.5rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        maxWidth: '90vw',
        width: '420px',
      }}
    >
      <span style={{ flex: 1, fontSize: '0.875rem' }}>
        {t('Enable notifications to get order updates', 'فعّل الإشعارات لتلقي تحديثات الطلبات')}
      </span>
      <button
        onClick={handleAccept}
        style={{
          padding: '0.375rem 0.75rem',
          borderRadius: '0.375rem',
          background: 'hsl(var(--primary))',
          color: 'hsl(var(--primary-foreground))',
          border: 'none',
          cursor: 'pointer',
          fontSize: '0.8125rem',
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {t('Accept', 'السماح')}
      </button>
      <button
        onClick={handleDismiss}
        aria-label={t('Dismiss notification prompt', 'تجاهل إشعار التنبيه')}
        style={{
          padding: '0.375rem 0.5rem',
          borderRadius: '0.375rem',
          background: 'transparent',
          color: 'hsl(var(--muted-foreground))',
          border: '1px solid hsl(var(--border))',
          cursor: 'pointer',
          fontSize: '0.8125rem',
          whiteSpace: 'nowrap',
        }}
      >
        {t('Dismiss', 'ليس الآن')}
      </button>
    </div>
  );
}
