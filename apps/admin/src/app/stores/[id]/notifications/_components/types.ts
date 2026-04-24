/**
 * Shared types and defaults for the notifications page. Kept in _components
 * so the page.tsx and its subcomponents import from the same module, avoiding
 * duplicate type declarations.
 */

export interface ChannelConfig {
  enabled: boolean;
  // WhatsApp
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  // SMS
  appSid?: string;
  senderId?: string;
  // Push (web-push / VAPID is platform-wide — no per-store credentials)
  subscriberCount?: number;
}

export interface NotificationConfigs {
  whatsapp: ChannelConfig;
  sms: ChannelConfig;
  push_notifications: ChannelConfig;
}

export type ChannelKey = keyof NotificationConfigs;

export interface EventConfig {
  event: string;
  label: string;
  whatsapp: boolean;
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
  whatsapp: { enabled: false },
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
  sent: { className: 'bg-success/10 text-success' },
  delivered: { className: 'bg-success/10 text-success' },
  failed: { className: 'bg-destructive/10 text-destructive' },
  pending: { className: 'bg-muted text-muted-foreground' },
  queued: { className: 'bg-primary/10 text-primary' },
} as const;

export const DEFAULT_EVENTS: EventConfig[] = [
  {
    event: 'order_confirmed',
    label: 'Order Confirmed',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_success',
    label: 'Payment Success',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'payment_failed',
    label: 'Payment Failed',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_shipped',
    label: 'Order Shipped',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_delivered',
    label: 'Order Delivered',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_cancelled',
    label: 'Order Cancelled',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
  {
    event: 'order_refunded',
    label: 'Order Refunded',
    whatsapp: false,
    sms: false,
    push_notifications: false,
  },
];
