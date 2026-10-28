/**
 * Bilingual labels for every OrderStatus / OrderPaymentStatus / PaymentStatus /
 * PaymentProvider value (packages/database/prisma/schema.prisma) plus the free-form
 * payment `method` strings providers write. Unknown values get a NEUTRAL label —
 * never the raw snake_case token (sense audit 1, finding on "Cod Pending").
 */

export type LabelPair = readonly [en: string, ar: string];
export type LabelLanguage = 'ar' | 'en';

const ORDER_STATUS: Record<string, LabelPair> = {
  pending: ['Pending', 'قيد الانتظار'],
  awaiting_payment_confirmation: ['Awaiting payment confirmation', 'في انتظار تأكيد الدفع'],
  confirmed: ['Confirmed', 'اتأكد'],
  processing: ['Processing', 'قيد التجهيز'],
  shipped: ['Shipped', 'اتشحن'],
  delivered: ['Delivered', 'اتسلّم'],
  cancelled: ['Cancelled', 'ملغي'],
  refunded: ['Refunded', 'اترد المبلغ'],
};

const ORDER_PAYMENT_STATUS: Record<string, LabelPair> = {
  unpaid: ['Unpaid', 'غير مدفوع'],
  paid: ['Paid', 'مدفوع'],
  partially_paid: ['Partially paid', 'مدفوع جزئياً'],
  failed: ['Payment failed', 'فشل الدفع'],
  refunded: ['Refunded', 'اترد المبلغ'],
  disputed: ['Disputed', 'قيد النزاع'],
};

const PAYMENT_STATUS: Record<string, LabelPair> = {
  pending: ['Pending', 'قيد الانتظار'],
  processing: ['Processing', 'قيد المعالجة'],
  completed: ['Completed', 'مكتمل'],
  failed: ['Failed', 'فشل'],
  cancelled: ['Cancelled', 'ملغي'],
  expired: ['Expired', 'انتهت المهلة'],
  refunded: ['Refunded', 'اترد المبلغ'],
  partially_refunded: ['Partially refunded', 'استرداد جزئي'],
  disputed: ['Disputed', 'قيد النزاع'],
  cod_pending: ['Pay on delivery', 'الدفع عند الاستلام'],
  paid: ['Paid', 'مدفوع'],
  unpaid: ['Unpaid', 'غير مدفوع'],
};

const PAYMENT_PROVIDER: Record<string, LabelPair> = {
  cod: ['Cash on delivery', 'الدفع عند الاستلام'],
  instapay: ['InstaPay', 'إنستاباي'],
  paymob: ['Paymob', 'باي موب'],
  kashier: ['Kashier', 'كاشير'],
  fawry: ['Fawry', 'فوري'],
  geidea: ['Geidea', 'جيديا'],
};

const PAYMENT_METHOD: Record<string, LabelPair> = {
  cod: ['Cash on delivery', 'الدفع عند الاستلام'],
  instapay: ['InstaPay', 'إنستاباي'],
  card: ['Card', 'بطاقة'],
  credit_card: ['Credit card', 'بطاقة ائتمان'],
  debit_card: ['Debit card', 'بطاقة خصم'],
  meeza: ['Meeza', 'ميزة'],
  wallet: ['Mobile wallet', 'محفظة إلكترونية'],
  mobile_wallet: ['Mobile wallet', 'محفظة إلكترونية'],
  payatfawry: ['Pay at Fawry', 'الدفع في فوري'],
  pay_at_fawry: ['Pay at Fawry', 'الدفع في فوري'],
  fawry: ['Fawry', 'فوري'],
  bank_transfer: ['Bank transfer', 'تحويل بنكي'],
  installments: ['Installments', 'تقسيط'],
};

const UNKNOWN: Record<string, LabelPair> = {
  status: ['Status unavailable', 'الحالة غير متاحة'],
  method: ['Other method', 'وسيلة أخرى'],
};

function norm(v: unknown): string {
  return typeof v === 'string'
    ? v
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : '';
}

function resolve(
  table: Record<string, LabelPair>,
  value: unknown,
  lang: LabelLanguage,
  fallback: LabelPair
): string {
  const pair = table[norm(value)] ?? fallback;
  return lang === 'ar' ? pair[1] : pair[0];
}

export function orderStatusLabel(value: unknown, lang: LabelLanguage): string {
  return resolve(ORDER_STATUS, value, lang, UNKNOWN.status);
}
export function orderPaymentStatusLabel(value: unknown, lang: LabelLanguage): string {
  return resolve(ORDER_PAYMENT_STATUS, value, lang, UNKNOWN.status);
}
export function paymentStatusLabel(value: unknown, lang: LabelLanguage): string {
  return resolve(PAYMENT_STATUS, value, lang, UNKNOWN.status);
}
export function paymentProviderLabel(value: unknown, lang: LabelLanguage): string {
  return resolve(PAYMENT_PROVIDER, value, lang, UNKNOWN.method);
}
export function paymentMethodLabel(value: unknown, lang: LabelLanguage): string {
  return resolve(PAYMENT_METHOD, value, lang, UNKNOWN.method);
}
