/**
 * Shared types and defaults for the notifications page. Kept in _components
 * so the page.tsx and its subcomponents import from the same module, avoiding
 * duplicate type declarations.
 *
 * WhatsApp is intentionally NOT a channel here (it is the separate Ebda
 * WhatsApp product).
 */

export interface ChannelConfig {
  enabled: boolean;
  // SMS
  appSid?: string;
  senderId?: string;
  // Push (web-push / VAPID is platform-wide — no per-store credentials)
  subscriberCount?: number;
}

export interface NotificationConfigs {
  sms: ChannelConfig;
  push_notifications: ChannelConfig;
}

export type ChannelKey = keyof NotificationConfigs;

export interface EventConfig {
  event: string;
  label: string;
  sms: boolean;
  push_notifications: boolean;
}

export interface NotificationLog {
  id: string;
  createdAt: string;
  event: string;
  channel: string;
  status: string;
  recipient?: string;
  error?: string;
}

export interface LogsData {
  logs: NotificationLog[];
  total: number;
  page: number;
  limit: number;
}

export type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export const DEFAULT_CONFIGS: NotificationConfigs = {
  sms: { enabled: false },
  push_notifications: { enabled: false },
};

/**
 * Color palette for the notification-log status pill. Handed to the shared
 * OrderStatusBadge via `colorMap`. Distinct from the shipment palette (different
 * vocabulary) and intentionally treats "sent" and "delivered" as equivalent
 * success states.
 */
export const NOTIFICATION_COLORS = {
  sent: { className: 'bg-success/10 text-success-ink' },
  delivered: { className: 'bg-success/10 text-success-ink' },
  failed: { className: 'bg-destructive/10 text-destructive-ink' },
  pending: { className: 'bg-muted text-muted-foreground' },
  queued: { className: 'bg-primary/10 text-primary-ink' },
} as const;

export const DEFAULT_EVENTS: EventConfig[] = [
  {
    event: 'order_confirmed',
    label: 'Order Confirmed',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_success',
    label: 'Payment Success',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_failed',
    label: 'Payment Failed',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_shipped',
    label: 'Order Shipped',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_delivered',
    label: 'Order Delivered',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_cancelled',
    label: 'Order Cancelled',
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_refunded',
    label: 'Order Refunded',
    sms: false,
    push_notifications: false,
  },
];

/**
 * The events endpoint answers `{ events: { [event]: { sms, push } } }` (a map of the rows the store saved); an older
 * shape was an array. Accept both and lay the saved switches over DEFAULT_EVENTS, so a saved config always shows.
 * Returns null when nothing usable came back (the defaults stay).
 */
export function mergeEventConfigs(raw: unknown): EventConfig[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const saved = new Map<string, { sms?: boolean; push?: boolean }>();
  if (Array.isArray(raw)) {
    for (const r of raw as Array<{
      event?: string;
      sms?: boolean;
      push?: boolean;
      push_notifications?: boolean;
    }>) {
      if (r?.event) saved.set(r.event, { sms: r.sms, push: r.push ?? r.push_notifications });
    }
  } else {
    for (const [event, v] of Object.entries(
      raw as Record<string, { sms?: boolean; push?: boolean }>
    )) {
      saved.set(event, { sms: v?.sms, push: v?.push });
    }
  }
  if (saved.size === 0) return null;
  return DEFAULT_EVENTS.map(d => {
    const s = saved.get(d.event);
    return s
      ? {
          ...d,
          sms: s.sms ?? d.sms,
          push_notifications: s.push ?? d.push_notifications,
        }
      : d;
  });
}
