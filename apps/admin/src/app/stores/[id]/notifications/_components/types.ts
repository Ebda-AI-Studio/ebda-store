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
 * STORE-QA-62: `GET /notifications/events` answers `{ events: { [event]: { whatsapp, sms, push } } }` (a record), but the page read
 * it as an array, so a saved toggle never came back after a reload. Fold the stored record (or a legacy array) over the defaults.
 */
export function mergeStoredEvents(stored: unknown): EventConfig[] {
  type Flags = { sms?: boolean; push?: boolean; push_notifications?: boolean };
  const byEvent = new Map<string, Flags>();
  if (Array.isArray(stored)) {
    for (const e of stored as Array<Flags & { event: string }>) byEvent.set(e.event, e);
  } else if (stored && typeof stored === 'object') {
    for (const [event, v] of Object.entries(stored as Record<string, object>))
      byEvent.set(event, v);
  }
  return DEFAULT_EVENTS.map(d => {
    const v = byEvent.get(d.event);
    return v
      ? { ...d, sms: v.sms === true, push_notifications: (v.push ?? v.push_notifications) === true }
      : d;
  });
}
