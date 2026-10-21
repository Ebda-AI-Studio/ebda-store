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
    ar: 'أهلاً {name}، طلبك رقم #{number} اتأكد. الإجمالي: {total}. شكراً إنك اشتريت من عندنا!',
  },
  payment_success: {
    en: 'Hi {name}, payment of {amount} for order #{number} was successful. Thank you!',
    ar: 'أهلاً {name}، استلمنا دفعتك {amount} للطلب رقم #{number}. شكراً!',
  },
  order_shipped: {
    en: 'Hi {name}, your order #{number} has been shipped. Track your package with: {tracking}',
    ar: 'أهلاً {name}، طلبك رقم #{number} اتشحن. تابع شحنتك برقم: {tracking}',
  },
  order_delivered: {
    en: 'Hi {name}, your order #{number} has been delivered. We hope you enjoy your purchase!',
    ar: 'أهلاً {name}، طلبك رقم #{number} اتسلّم. نتمنى يعجبك!',
  },
  order_cancelled: {
    en: 'Hi {name}, your order #{number} has been cancelled. Reason: {reason}. Contact us for support.',
    ar: 'أهلاً {name}، طلبك رقم #{number} اتلغى. السبب: {reason}. كلّمنا لو محتاج مساعدة.',
  },
  refund_processed: {
    en: 'Hi {name}, a refund of {amount} for order #{number} has been processed. It may take 3-5 business days.',
    ar: 'أهلاً {name}، بنرجّعلك {amount} من الطلب رقم #{number}. ممكن ياخد من 3 لـ 5 أيام عمل.',
  },
  cart_abandoned_step1: {
    en: 'Hi {name}, you left {cartItemCount} items ({cartTotal} EGP) in your cart at {storeName}. Complete your order: {cartUrl}',
    ar: 'أهلاً {name}، سيبت {cartItemCount} عناصر ({cartTotal} ج.م) في سلتك في {storeName}. كمّل طلبك: {cartUrl}',
  },
  cart_abandoned_step2: {
    en: 'Hi {name}, your items are still waiting! Complete your order now: {cartUrl}',
    ar: 'أهلاً {name}، منتجاتك لسه مستنياك! كمّل طلبك دلوقتي: {cartUrl}',
  },
  cart_abandoned_step3: {
    en: '{name}, last chance! {couponCode} Complete your order: {cartUrl}',
    ar: '{name}، آخر فرصة! {couponCode} كمّل طلبك: {cartUrl}',
  },
  back_in_stock: {
    en: 'Hi {name}, great news! "{productName}" is back in stock at {storeName}. Shop now: {productUrl}',
    ar: 'أهلاً {name}، خبر حلو! "{productName}" رجع في {storeName}. اطلبه دلوقتي: {productUrl}',
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
      ar: 'طلبك اتأكد',
    },
    body: {
      en: 'Hi {name}, your order #{number} has been confirmed. Total: {total}.',
      ar: 'أهلاً {name}، طلبك رقم #{number} اتأكد. الإجمالي: {total}.',
    },
  },
  payment_success: {
    title: {
      en: 'Payment Successful',
      ar: 'الدفع وصلنا',
    },
    body: {
      en: 'Payment of {amount} for order #{number} was received successfully.',
      ar: 'استلمنا دفعتك {amount} للطلب رقم #{number}.',
    },
  },
  order_shipped: {
    title: {
      en: 'Order Shipped',
      ar: 'طلبك اتشحن',
    },
    body: {
      en: 'Your order #{number} is on its way. Tracking: {tracking}.',
      ar: 'طلبك رقم #{number} في الطريق ليك. رقم التتبع: {tracking}.',
    },
  },
  order_delivered: {
    title: {
      en: 'Order Delivered',
      ar: 'طلبك اتسلّم',
    },
    body: {
      en: 'Hi {name}, your order #{number} has been delivered. Enjoy!',
      ar: 'أهلاً {name}، طلبك رقم #{number} اتسلّم. نتمنى يعجبك!',
    },
  },
  order_cancelled: {
    title: {
      en: 'Order Cancelled',
      ar: 'طلبك اتلغى',
    },
    body: {
      en: 'Your order #{number} has been cancelled. Reason: {reason}.',
      ar: 'طلبك رقم #{number} اتلغى. السبب: {reason}.',
    },
  },
  refund_processed: {
    title: {
      en: 'Refund Processed',
      ar: 'بنرجّعلك فلوسك',
    },
    body: {
      en: 'A refund of {amount} for order #{number} has been processed.',
      ar: 'بنرجّعلك {amount} من الطلب رقم #{number}.',
    },
  },
  cart_abandoned_step1: {
    title: {
      en: 'You left something behind!',
      ar: 'سيبت حاجة في السلة!',
    },
    body: {
      en: 'Hi {name}, you have {cartItemCount} items worth {cartTotal} EGP waiting in your cart.',
      ar: 'أهلاً {name}، عندك {cartItemCount} عناصر بقيمة {cartTotal} ج.م مستنياك في سلتك.',
    },
  },
  cart_abandoned_step2: {
    title: {
      en: 'Your cart is waiting for you',
      ar: 'سلتك مستنياك',
    },
    body: {
      en: 'Hi {name}, your items are still in your cart. Complete your order before they sell out!',
      ar: 'أهلاً {name}، منتجاتك لسه في سلتك. كمّل طلبك قبل ما الكمية تخلص!',
    },
  },
  cart_abandoned_step3: {
    title: {
      en: 'Last chance — complete your order!',
      ar: 'آخر فرصة — كمّل طلبك!',
    },
    body: {
      en: '{name}, your cart is about to expire. Use {couponCode} to save on your order.',
      ar: '{name}، سلتك قربت تخلص. استخدم {couponCode} ووفّر في طلبك.',
    },
  },
  back_in_stock: {
    title: {
      en: 'Back in Stock!',
      ar: 'رجع تاني!',
    },
    body: {
      en: 'Hi {name}, "{productName}" is now available again at {storeName}.',
      ar: 'أهلاً {name}، "{productName}" رجع تاني في {storeName}.',
    },
  },
};
