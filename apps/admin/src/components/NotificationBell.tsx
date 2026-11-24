'use client';

import { Button } from '@/components/ui/Button';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useNotifications } from '@/contexts/NotificationContext';
import { formatDistanceToNow } from 'date-fns';
import { useT } from '@/i18n/useT';
import { TONE_CLASSES, getStatusEntry } from '@/lib/status-tones';

const iconMap: Record<string, string> = {
  new_order: '🛒',
  new_review: '⭐',
  new_return: '↩️',
  low_stock: '📦',
  order_status: '📋',
  return_status: '🔄',
};

export function NotificationBell() {
  const t = useT('components.notificationBell');
  const router = useRouter();
  const { notifications, unreadCount, isConnected, markAsRead, markAllAsRead, clearNotifications } =
    useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The dropdown is rendered in a body portal (fixed position) so it escapes
  // the admin header's stacking/clip context — the header has `backdrop-blur`,
  // which establishes a containing block + new stacking context that clipped
  // the old `absolute` panel (it rendered behind the sidebar, header cut off).
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const width = Math.min(384, window.innerWidth - 16);
      // Right-align the panel under the bell, then clamp inside the viewport
      // so it can never run off either edge (works in LTR + RTL).
      let left = rect.right - width;
      if (left < 8) left = 8;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
      setCoords({ top: rect.bottom + 8, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen]);

  // Initial-connect grace period. The bell mounts with `isConnected=false`
  // because the socket handshake hasn't completed yet. Without this
  // delay the "Reconnecting…" footer flashes on every page render in
  // the moments before the first connect, which the merchant reports
  // as "always there". 3s covers a normal handshake (typically <500ms
  // over a healthy connection) with margin for cold-starts.
  const [showReconnecting, setShowReconnecting] = useState(false);
  useEffect(() => {
    if (isConnected) {
      setShowReconnecting(false);
      return;
    }
    const timer = window.setTimeout(() => setShowReconnecting(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [isConnected]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      // The panel lives in a body portal, so it's NOT inside dropdownRef —
      // check both the trigger wrapper and the portal panel before closing.
      const inTrigger = dropdownRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inTrigger && !inPanel) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Click handler: mark read AND navigate to the related resource if
  // the notification carries a `data.url`. Without this the merchant
  // sees a "New Order Received" entry and has to manually go find
  // the order; with it the entire row is a button to the order
  // detail page.
  function handleNotificationClick(notification: (typeof notifications)[number]) {
    markAsRead(notification.id);
    const url = typeof notification.data?.url === 'string' ? notification.data.url : null;
    if (url) {
      setIsOpen(false);
      router.push(url);
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <Button
        variant="ghost"
        size="icon"
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative"
        aria-label={t('ariaLabel')}
      >
        <svg
          className="w-6 h-6 text-muted-foreground dark:text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>

        {/* Unread Badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -end-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-destructive rounded-full">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}

        {/* Connection Status Indicator */}
        <span
          className={`absolute bottom-1 end-1 w-2 h-2 rounded-full ${
            isConnected ? 'bg-success' : 'bg-muted-foreground'
          }`}
        />
      </Button>

      {/* Dropdown — rendered in a body portal with fixed positioning so the
          header's backdrop-blur stacking/clip context can't trap it. */}
      {isOpen &&
        coords &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: coords.top, left: coords.left, width: coords.width }}
            className="bg-card rounded-md shadow-xl border border-border z-[100] overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-muted border-b border-border">
              <h3 className="font-semibold text-foreground">{t('title')}</h3>
              <div className="flex gap-2">
                {unreadCount > 0 && (
                  <Button variant="link" size="sm" type="button" onClick={markAllAsRead}>
                    {t('markAllRead')}
                  </Button>
                )}
                {notifications.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={clearNotifications}
                    className="text-muted-foreground dark:text-muted-foreground"
                  >
                    {t('clear')}
                  </Button>
                )}
              </div>
            </div>

            {/* Notification List */}
            <div className="max-h-[400px] overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="py-12 text-center">
                  <svg
                    className="w-12 h-12 mx-auto text-muted-foreground/60 dark:text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                    />
                  </svg>
                  <p className="mt-3 text-sm text-muted-foreground dark:text-muted-foreground">
                    {t('empty')}
                  </p>
                </div>
              ) : (
                <ul>
                  {notifications.map(notification => (
                    <li
                      key={notification.id}
                      onClick={() => handleNotificationClick(notification)}
                      className={`px-4 py-3 border-b border-border dark:border-border hover:bg-muted dark:hover:bg-foreground/50 cursor-pointer transition-colors ${
                        !notification.read ? 'bg-primary/5' : ''
                      }`}
                    >
                      <div className="flex gap-3">
                        {/* Icon */}
                        <div
                          className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg ${
                            TONE_CLASSES[getStatusEntry('notificationType', notification.type).tone]
                          }`}
                        >
                          {iconMap[notification.type] || '🔔'}
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium text-sm text-foreground dark:text-white truncate">
                              {notification.title}
                            </p>
                            {!notification.read && (
                              <span className="flex-shrink-0 w-2 h-2 bg-primary rounded-full mt-1.5" />
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground dark:text-muted-foreground line-clamp-2">
                            {notification.message}
                          </p>
                          <p className="text-xs text-muted-foreground dark:text-muted-foreground mt-1">
                            {formatDistanceToNow(notification.createdAt, { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Footer — only after the 3s grace window (see showReconnecting) */}
            {!isConnected && showReconnecting && (
              <div className="px-4 py-2 bg-warning/5 dark:bg-warning/30 border-t border-warning/30">
                <p className="text-xs text-warning-ink dark:text-warning-ink flex items-center gap-1">
                  <span className="w-2 h-2 bg-warning rounded-full animate-pulse" />
                  {t('reconnecting')}
                </p>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
