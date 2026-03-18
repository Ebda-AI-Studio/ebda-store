// Communication Hub — Notification Types, Templates, and Schemas
import { z } from 'zod';

// ─── Channels ────────────────────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = ['whatsapp', 'sms', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// ─── Events ──────────────────────────────────────────────────────────────────

export const NOTIFICATION_EVENTS = [
  'order_confirmed',
  'payment_success',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'refund_processed',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

// ─── Notification Data ────────────────────────────────────────────────────────

export interface NotificationData {
  customerName: string;
  customerPhone?: string;
  orderNumber: string;
  total?: number;
  trackingNumber?: string;
  reason?: string;
  amount?: number;
  storeId: string;
  storeName: string;
}

// ─── WhatsApp Templates ───────────────────────────────────────────────────────

export interface WhatsAppTemplate {
  name: string;
  variables: (data: NotificationData) => string[];
}

export const WHATSAPP_TEMPLATES: Record<NotificationEvent, WhatsAppTemplate> = {
  order_confirmed: {
    name: 'order_confirmed',
    variables: data => [
      data.customerName,
      data.orderNumber,
      data.total !== undefined ? data.total.toFixed(2) : '0.00',
    ],
  },
  payment_success: {
    name: 'payment_success',
    variables: data => [
      data.customerName,
      data.orderNumber,
      data.amount !== undefined ? data.amount.toFixed(2) : '0.00',
    ],
  },
  order_shipped: {
    name: 'order_shipped',
    variables: data => [data.customerName, data.orderNumber, data.trackingNumber ?? ''],
  },
  order_delivered: {
    name: 'order_delivered',
    variables: data => [data.customerName, data.orderNumber],
  },
  order_cancelled: {
    name: 'order_cancelled',
    variables: data => [data.customerName, data.orderNumber, data.reason ?? ''],
  },
  refund_processed: {
    name: 'refund_processed',
    variables: data => [
      data.customerName,
      data.orderNumber,
      data.amount !== undefined ? data.amount.toFixed(2) : '0.00',
    ],
  },
};

// ─── SMS Templates ────────────────────────────────────────────────────────────

export interface SmsTemplate {
  en: string;
  ar: string;
}

export const SMS_TEMPLATES: Record<NotificationEvent, SmsTemplate> = {
  order_confirmed: {
    en: 'Hi {name}, your order #{number} has been confirmed. Total: {total}. Thank you for shopping with us!',
    ar: 'مرحباً {name}، تم تأكيد طلبك رقم #{number}. الإجمالي: {total}. شكراً لتسوقك معنا!',
  },
  payment_success: {
    en: 'Hi {name}, payment of {amount} for order #{number} was successful. Thank you!',
    ar: 'مرحباً {name}، تم استلام دفعة {amount} للطلب رقم #{number} بنجاح. شكراً!',
  },
  order_shipped: {
    en: 'Hi {name}, your order #{number} has been shipped. Track your package with: {tracking}',
    ar: 'مرحباً {name}، تم شحن طلبك رقم #{number}. تتبع طردك برقم: {tracking}',
  },
  order_delivered: {
    en: 'Hi {name}, your order #{number} has been delivered. We hope you enjoy your purchase!',
    ar: 'مرحباً {name}، تم تسليم طلبك رقم #{number}. نأمل أن تستمتع بمشترياتك!',
  },
  order_cancelled: {
    en: 'Hi {name}, your order #{number} has been cancelled. Reason: {reason}. Contact us for support.',
    ar: 'مرحباً {name}، تم إلغاء طلبك رقم #{number}. السبب: {reason}. تواصل معنا للدعم.',
  },
  refund_processed: {
    en: 'Hi {name}, a refund of {amount} for order #{number} has been processed. It may take 3-5 business days.',
    ar: 'مرحباً {name}، تمت معالجة استرداد {amount} للطلب رقم #{number}. قد يستغرق 3-5 أيام عمل.',
  },
};

export function renderSmsTemplate(template: string, data: NotificationData): string {
  return template
    .replace('{name}', data.customerName)
    .replace('{number}', data.orderNumber)
    .replace('{total}', data.total !== undefined ? data.total.toFixed(2) : '')
    .replace('{tracking}', data.trackingNumber ?? '')
    .replace('{reason}', data.reason ?? '')
    .replace('{amount}', data.amount !== undefined ? data.amount.toFixed(2) : '');
}

// ─── Push Templates ───────────────────────────────────────────────────────────

export interface PushTemplate {
  title: { en: string; ar: string };
  body: { en: string; ar: string };
}

export const PUSH_TEMPLATES: Record<NotificationEvent, PushTemplate> = {
  order_confirmed: {
    title: {
      en: 'Order Confirmed',
      ar: 'تم تأكيد الطلب',
    },
    body: {
      en: 'Hi {name}, your order #{number} has been confirmed. Total: {total}.',
      ar: 'مرحباً {name}، تم تأكيد طلبك رقم #{number}. الإجمالي: {total}.',
    },
  },
  payment_success: {
    title: {
      en: 'Payment Successful',
      ar: 'تمت عملية الدفع بنجاح',
    },
    body: {
      en: 'Payment of {amount} for order #{number} was received successfully.',
      ar: 'تم استلام دفعة {amount} للطلب رقم #{number} بنجاح.',
    },
  },
  order_shipped: {
    title: {
      en: 'Order Shipped',
      ar: 'تم شحن الطلب',
    },
    body: {
      en: 'Your order #{number} is on its way. Tracking: {tracking}.',
      ar: 'طلبك رقم #{number} في الطريق إليك. رقم التتبع: {tracking}.',
    },
  },
  order_delivered: {
    title: {
      en: 'Order Delivered',
      ar: 'تم تسليم الطلب',
    },
    body: {
      en: 'Hi {name}, your order #{number} has been delivered. Enjoy!',
      ar: 'مرحباً {name}، تم تسليم طلبك رقم #{number}. استمتع بمشترياتك!',
    },
  },
  order_cancelled: {
    title: {
      en: 'Order Cancelled',
      ar: 'تم إلغاء الطلب',
    },
    body: {
      en: 'Your order #{number} has been cancelled. Reason: {reason}.',
      ar: 'تم إلغاء طلبك رقم #{number}. السبب: {reason}.',
    },
  },
  refund_processed: {
    title: {
      en: 'Refund Processed',
      ar: 'تمت معالجة الاسترداد',
    },
    body: {
      en: 'A refund of {amount} for order #{number} has been processed.',
      ar: 'تمت معالجة استرداد {amount} للطلب رقم #{number}.',
    },
  },
};

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);

export const notificationEventConfigSchema = z.object({
  whatsapp: z.boolean(),
  sms: z.boolean(),
  push: z.boolean(),
});

export type NotificationEventConfig = z.infer<typeof notificationEventConfigSchema>;
