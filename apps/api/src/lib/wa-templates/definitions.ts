/**
 * Canonical Force AI WhatsApp template library.
 *
 * Six templates × two languages (en + ar) = twelve total Meta template
 * submissions per merchant. All variables-only — merchants pick from this
 * fixed library; they can't edit the body text (safer for Meta approval).
 *
 * Variable placeholders are positional 1..N. When sending, the WBS bridge
 * passes a `variables` array matching {{1}}..{{N}} order.
 *
 * Template naming convention: `force_<purpose>_<version>` where version
 * lets us iterate template text without orphaning existing approvals
 * (e.g. `force_order_paid_v1` → `force_order_paid_v2` next iteration).
 */

export type TemplateLanguage = 'en' | 'ar';
export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';

export interface TemplateComponent {
  type: 'BODY' | 'FOOTER' | 'HEADER' | 'BUTTONS';
  text?: string;
  example?: {
    body_text?: string[][];
  };
}

export interface TemplateDefinition {
  /** Internal purpose key — orderPaid, paymentLink, etc. */
  sourceKey: string;
  /** Meta-side template name (lowercase + underscores only). */
  name: string;
  language: TemplateLanguage;
  /** Meta-language code (en → 'en', ar → 'ar' for the standard variant). */
  metaLanguage: string;
  category: TemplateCategory;
  /** Human-readable purpose for the admin UI. */
  description: string;
  /** Variable count for {{1}}..{{N}} placeholders in the BODY. */
  variableCount: number;
  /** Variable purpose labels for UI documentation. */
  variableLabels: string[];
  components: TemplateComponent[];
}

/**
 * Source-key index for fast lookups + UI grouping.
 */
export type TemplateSourceKey =
  | 'orderPaid'
  | 'orderShipped'
  | 'orderDelivered'
  | 'welcomeBack'
  | 'cartAbandoned'
  | 'paymentLink';

export const TEMPLATE_SOURCE_KEYS: TemplateSourceKey[] = [
  'orderPaid',
  'orderShipped',
  'orderDelivered',
  'welcomeBack',
  'cartAbandoned',
  'paymentLink',
];

export const TEMPLATES: TemplateDefinition[] = [
  // ───── orderPaid ─────
  {
    sourceKey: 'orderPaid',
    name: 'force_order_paid_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'UTILITY',
    description: 'Sent automatically after a customer completes payment.',
    variableCount: 4,
    variableLabels: ['Customer name', 'Order number', 'Order total', 'Store name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order {{2}} for {{3}} from {{4}} has been received. Thank you!',
        example: {
          body_text: [['Ahmad', 'ORD-1042', '5.500 KWD', 'Wady Aljuz']],
        },
      },
      {
        type: 'FOOTER',
        text: 'We will message you when it ships.',
      },
    ],
  },
  {
    sourceKey: 'orderPaid',
    name: 'force_order_paid_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'UTILITY',
    description: 'تُرسل تلقائيًا بعد إتمام الدفع.',
    variableCount: 4,
    variableLabels: ['اسم العميل', 'رقم الطلب', 'إجمالي الطلب', 'اسم المتجر'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا {{1}}، تم استلام طلبك {{2}} بقيمة {{3}} من {{4}}. شكرًا لك!',
        example: {
          body_text: [['أحمد', 'ORD-1042', '5.500 د.ك', 'وادي الجوز']],
        },
      },
      {
        type: 'FOOTER',
        text: 'سنرسل لك رسالة عند شحن الطلب.',
      },
    ],
  },

  // ───── orderShipped ─────
  {
    sourceKey: 'orderShipped',
    name: 'force_order_shipped_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'UTILITY',
    description: 'Sent when the order ships. Includes tracking number.',
    variableCount: 5,
    variableLabels: [
      'Customer name',
      'Order number',
      'Order total',
      'Store name',
      'Tracking number',
    ],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order {{2}} for {{3}} from {{4}} is on the way! Tracking number: {{5}}.',
        example: {
          body_text: [['Ahmad', 'ORD-1042', '5.500 KWD', 'Wady Aljuz', 'KW123456789']],
        },
      },
    ],
  },
  {
    sourceKey: 'orderShipped',
    name: 'force_order_shipped_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'UTILITY',
    description: 'تُرسل عند شحن الطلب مع رقم التتبع.',
    variableCount: 5,
    variableLabels: ['اسم العميل', 'رقم الطلب', 'إجمالي الطلب', 'اسم المتجر', 'رقم التتبع'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا {{1}}، طلبك {{2}} بقيمة {{3}} من {{4}} في الطريق! رقم التتبع: {{5}}.',
        example: {
          body_text: [['أحمد', 'ORD-1042', '5.500 د.ك', 'وادي الجوز', 'KW123456789']],
        },
      },
    ],
  },

  // ───── orderDelivered ─────
  {
    sourceKey: 'orderDelivered',
    name: 'force_order_delivered_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'UTILITY',
    description: 'Sent when the order is marked delivered.',
    variableCount: 4,
    variableLabels: ['Customer name', 'Order number', 'Order total', 'Store name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, your order {{2}} for {{3}} has been delivered. Thanks for shopping with {{4}}!',
        example: {
          body_text: [['Ahmad', 'ORD-1042', '5.500 KWD', 'Wady Aljuz']],
        },
      },
      {
        type: 'FOOTER',
        text: 'We hope you love it.',
      },
    ],
  },
  {
    sourceKey: 'orderDelivered',
    name: 'force_order_delivered_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'UTILITY',
    description: 'تُرسل عند تسليم الطلب.',
    variableCount: 4,
    variableLabels: ['اسم العميل', 'رقم الطلب', 'إجمالي الطلب', 'اسم المتجر'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا {{1}}، تم تسليم طلبك {{2}} بقيمة {{3}}. شكرًا لاختيارك {{4}}!',
        example: {
          body_text: [['أحمد', 'ORD-1042', '5.500 د.ك', 'وادي الجوز']],
        },
      },
      {
        type: 'FOOTER',
        text: 'نأمل أن يعجبك.',
      },
    ],
  },

  // ───── welcomeBack ─────
  {
    sourceKey: 'welcomeBack',
    name: 'force_welcome_back_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'MARKETING',
    description: 'Re-engagement message for returning customers.',
    variableCount: 2,
    variableLabels: ['Customer name', 'Store name'],
    components: [
      {
        type: 'BODY',
        text: 'Welcome back, {{1}}! New arrivals just landed at {{2}}. Reply "menu" to browse the latest collection.',
        example: {
          body_text: [['Ahmad', 'Wady Aljuz']],
        },
      },
    ],
  },
  {
    sourceKey: 'welcomeBack',
    name: 'force_welcome_back_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'MARKETING',
    description: 'رسالة إعادة تفاعل للعملاء العائدين.',
    variableCount: 2,
    variableLabels: ['اسم العميل', 'اسم المتجر'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا بعودتك {{1}}! وصلت منتجات جديدة إلى {{2}}. اكتب "قائمة" لتصفح أحدث المجموعة.',
        example: {
          body_text: [['أحمد', 'وادي الجوز']],
        },
      },
    ],
  },

  // ───── cartAbandoned ─────
  {
    sourceKey: 'cartAbandoned',
    name: 'force_cart_abandoned_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'MARKETING',
    description: 'Reminder when a customer leaves items in their cart.',
    variableCount: 3,
    variableLabels: ['Customer name', 'Cart total', 'Store name'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, you left {{2}} worth of items in your cart at {{3}}. Reply "checkout" to complete your order.',
        example: {
          body_text: [['Ahmad', '5.500 KWD', 'Wady Aljuz']],
        },
      },
    ],
  },
  {
    sourceKey: 'cartAbandoned',
    name: 'force_cart_abandoned_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'MARKETING',
    description: 'تذكير عندما يترك العميل منتجات في السلة.',
    variableCount: 3,
    variableLabels: ['اسم العميل', 'إجمالي السلة', 'اسم المتجر'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا {{1}}، لديك منتجات بقيمة {{2}} في سلتك في {{3}}. اكتب "إتمام الطلب" لإكمال الشراء.',
        example: {
          body_text: [['أحمد', '5.500 د.ك', 'وادي الجوز']],
        },
      },
    ],
  },

  // ───── paymentLink ─────
  {
    sourceKey: 'paymentLink',
    name: 'force_payment_link_v1',
    language: 'en',
    metaLanguage: 'en',
    category: 'UTILITY',
    description: 'Merchant-initiated payment link with a 30-minute expiry.',
    variableCount: 5,
    variableLabels: ['Customer name', 'Order total', 'Currency', 'Store name', 'Checkout URL'],
    components: [
      {
        type: 'BODY',
        text: 'Hi {{1}}, here is your payment link from {{4}} for {{2}} {{3}}: {{5}}. The link expires in 30 minutes.',
        example: {
          body_text: [
            [
              'Ahmad',
              '5.500',
              'KWD',
              'Wady Aljuz',
              'https://wadyaljuz.com/checkout?waToken=abc123',
            ],
          ],
        },
      },
      {
        type: 'FOOTER',
        text: 'Powered by Force AI',
      },
    ],
  },
  {
    sourceKey: 'paymentLink',
    name: 'force_payment_link_v1',
    language: 'ar',
    metaLanguage: 'ar',
    category: 'UTILITY',
    description: 'رابط دفع تُرسله إدارة المتجر، صالح لمدة 30 دقيقة.',
    variableCount: 5,
    variableLabels: ['اسم العميل', 'إجمالي الطلب', 'العملة', 'اسم المتجر', 'رابط الدفع'],
    components: [
      {
        type: 'BODY',
        text: 'مرحبًا {{1}}، هذا رابط الدفع من {{4}} بقيمة {{2}} {{3}}: {{5}}. الرابط صالح لمدة 30 دقيقة.',
        example: {
          body_text: [
            ['أحمد', '5.500', 'د.ك', 'وادي الجوز', 'https://wadyaljuz.com/checkout?waToken=abc123'],
          ],
        },
      },
      {
        type: 'FOOTER',
        text: 'مدعوم بواسطة Force AI',
      },
    ],
  },
];

/**
 * Lookup helper — find every language variant of a given source key.
 */
export function templatesByKey(sourceKey: TemplateSourceKey): TemplateDefinition[] {
  return TEMPLATES.filter(t => t.sourceKey === sourceKey);
}

/**
 * Lookup helper — find the canonical template for a (sourceKey, language) pair.
 */
export function findTemplate(
  sourceKey: TemplateSourceKey,
  language: TemplateLanguage
): TemplateDefinition | undefined {
  return TEMPLATES.find(t => t.sourceKey === sourceKey && t.language === language);
}
