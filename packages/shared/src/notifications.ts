// Communication Hub — Notification Types and Templates

// ─── Channels ────────────────────────────────────────────────────────────────

export type NotificationChannel = 'whatsapp' | 'sms' | 'push';

// ─── Events ──────────────────────────────────────────────────────────────────

export type NotificationEvent =
  | 'order_confirmed'
  | 'payment_success'
  | 'order_shipped'
  | 'order_delivered'
  | 'order_cancelled'
  | 'refund_processed'
  | 'cart_abandoned_step1'
  | 'cart_abandoned_step2'
  | 'cart_abandoned_step3'
  | 'back_in_stock';

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
  cartUrl?: string;
  cartTotal?: string;
  cartItemCount?: number;
  couponCode?: string;
  productName?: string;
  productUrl?: string;
  /**
   * Per-recipient idempotency suffix for events with no order number
   * (back_in_stock). The SMS idempotency key falls back to `orderNumber`.
   *
   * There is deliberately no consent field here: promotional SMS consent is
   * read by the dispatcher from `sms_marketing_consents` for the recipient's
   * phone (issue 206), never trusted from the caller.
   */
  dedupeKey?: string;
}

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
  cart_abandoned_step1: {
    en: 'Hi {name}, you left {cartItemCount} items ({cartTotal} KWD) in your cart at {storeName}. Complete your order: {cartUrl}',
    ar: 'مرحباً {name}، تركت {cartItemCount} عناصر ({cartTotal} د.ك) في سلتك في {storeName}. أكمل طلبك: {cartUrl}',
  },
  cart_abandoned_step2: {
    en: 'Hi {name}, your items are still waiting! Complete your order now: {cartUrl}',
    ar: 'مرحباً {name}، عناصرك لا تزال بانتظارك! أكمل طلبك الآن: {cartUrl}',
  },
  cart_abandoned_step3: {
    en: '{name}, last chance! {couponCode} Complete your order: {cartUrl}',
    ar: '{name}، فرصتك الأخيرة! {couponCode} أكمل طلبك: {cartUrl}',
  },
  back_in_stock: {
    en: 'Hi {name}, great news! "{productName}" is back in stock at {storeName}. Shop now: {productUrl}',
    ar: 'مرحباً {name}، خبر رائع! "{productName}" عاد للمخزن في {storeName}. تسوق الآن: {productUrl}',
  },
};

export function renderSmsTemplate(template: string, data: NotificationData): string {
  return template
    .replace('{name}', data.customerName)
    .replace('{number}', data.orderNumber)
    .replace('{total}', data.total !== undefined ? data.total.toFixed(2) : '')
    .replace('{tracking}', data.trackingNumber ?? '')
    .replace('{reason}', data.reason ?? '')
    .replace('{amount}', data.amount !== undefined ? data.amount.toFixed(2) : '')
    .replace('{cartUrl}', data.cartUrl ?? '')
    .replace('{cartTotal}', data.cartTotal ?? '')
    .replace('{cartItemCount}', data.cartItemCount !== undefined ? String(data.cartItemCount) : '')
    .replace('{couponCode}', data.couponCode ? `${data.couponCode}` : '')
    .replace('{storeName}', data.storeName)
    .replace('{productName}', data.productName ?? '')
    .replace('{productUrl}', data.productUrl ?? '');
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
  cart_abandoned_step1: {
    title: {
      en: 'You left something behind!',
      ar: 'تركت شيئاً خلفك!',
    },
    body: {
      en: 'Hi {name}, you have {cartItemCount} items worth {cartTotal} KWD waiting in your cart.',
      ar: 'مرحباً {name}، لديك {cartItemCount} عناصر بقيمة {cartTotal} د.ك بانتظارك في سلتك.',
    },
  },
  cart_abandoned_step2: {
    title: {
      en: 'Your cart is waiting for you',
      ar: 'سلتك بانتظارك',
    },
    body: {
      en: 'Hi {name}, your items are still in your cart. Complete your order before they sell out!',
      ar: 'مرحباً {name}، عناصرك لا تزال في سلتك. أكمل طلبك قبل نفاد الكمية!',
    },
  },
  cart_abandoned_step3: {
    title: {
      en: 'Last chance — complete your order!',
      ar: 'فرصتك الأخيرة — أكمل طلبك!',
    },
    body: {
      en: '{name}, your cart is about to expire. Use {couponCode} to save on your order.',
      ar: '{name}، سلتك على وشك الانتهاء. استخدم {couponCode} لتوفير على طلبك.',
    },
  },
  back_in_stock: {
    title: {
      en: 'Back in Stock!',
      ar: 'عاد للمخزن!',
    },
    body: {
      en: 'Hi {name}, "{productName}" is now available again at {storeName}.',
      ar: 'مرحباً {name}، "{productName}" متوفر مجدداً في {storeName}.',
    },
  },
};
