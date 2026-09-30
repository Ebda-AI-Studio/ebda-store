/**
 * Shared types and defaults for the notifications page. Kept in _components
 * so the page.tsx and its subcomponents import from the same module, avoiding
 * duplicate type declarations.
 *
 * WhatsApp is intentionally NOT a channel here — it flows through the Force
 * Store ↔ WBS bridge, configured at /stores/:id/integrations/wbs.
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
