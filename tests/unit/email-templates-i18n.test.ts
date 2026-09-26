/**
 * Bilingual email-templates i18n tests.
 *
 * Each template module is exercised directly (pure function — no DB, no HTTP).
 * Tests verify:
 *   - English body renders expected English copy + data interpolation
 *   - Arabic body renders expected Arabic copy + data interpolation
 *   - Subject lines are correct for both languages
 *   - XSS-dangerous characters in data are escaped in both variants
 *   - Currency rendered as KWD (en) / د.ك (ar) on money templates
 */

import { describe, it, expect } from 'vitest';

import { welcomeTemplate } from '@api/services/email-templates/welcome';
import { passwordResetTemplate } from '@api/services/email-templates/password-reset';
import { emailVerificationTemplate } from '@api/services/email-templates/email-verification';
import { resendVerificationTemplate } from '@api/services/email-templates/resend-verification';
import { duplicateRegistrationTemplate } from '@api/services/email-templates/duplicate-registration';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import { paymentSuccessTemplate } from '@api/services/email-templates/payment-success';
import { paymentFailedTemplate } from '@api/services/email-templates/payment-failed';
import { orderShippedTemplate } from '@api/services/email-templates/order-shipped';
import { returnConfirmationTemplate } from '@api/services/email-templates/return-confirmation';
import { returnStatusUpdateTemplate } from '@api/services/email-templates/return-status-update';

const STORE = 'Wady Aljuz';
const WEB_URL = 'https://store.test';
const XSS = '<script>alert(1)</script>';

// ---------------------------------------------------------------------------
// welcome
// ---------------------------------------------------------------------------

describe('welcomeTemplate', () => {
  const data = { email: 'a@example.com', name: 'Ahmad' };

  it('en subject includes store name', () => {
    expect(welcomeTemplate.subject.en(data, STORE)).toBe(`Welcome to ${STORE}`);
  });

  it('ar subject includes store name in Arabic', () => {
    expect(welcomeTemplate.subject.ar(data, STORE)).toContain('مرحباً بك في');
    expect(welcomeTemplate.subject.ar(data, STORE)).toContain(STORE);
  });

  it('en body contains English greeting', () => {
    const html = welcomeTemplate.en(data, STORE, WEB_URL);
    expect(html).toContain('Welcome');
    expect(html).toContain('Ahmad');
  });

  it('ar body contains Arabic greeting', () => {
    const html = welcomeTemplate.ar(data, STORE, WEB_URL);
    expect(html).toContain('أهلاً');
    expect(html).toContain('Ahmad');
  });

  it('XSS is escaped in en body', () => {
    const html = welcomeTemplate.en({ ...data, name: XSS }, STORE, WEB_URL);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('XSS is escaped in ar body', () => {
    const html = welcomeTemplate.ar({ ...data, name: XSS }, STORE, WEB_URL);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// password-reset
// ---------------------------------------------------------------------------

describe('passwordResetTemplate', () => {
  const data = {
    email: 'a@example.com',
    name: 'Ahmad',
    resetUrl: 'https://store.test/reset?token=abc',
    // S5-2 (2026-09-22 security audit): TTL is now 15 minutes (was 1 hour),
    // and the template takes a minute COUNT, not a pre-formatted English
    // phrase, so the ar body below can render its own Arabic copy instead
    // of embedding "1 hour" verbatim.
    expiresInMinutes: 15,
  };

  it('en subject', () => {
    expect(passwordResetTemplate.subject.en(data, STORE)).toBe('Reset Your Password');
  });

  it('ar subject', () => {
    expect(passwordResetTemplate.subject.ar(data, STORE)).toContain('إعادة تعيين');
  });

  it('en body contains reset URL and expiry', () => {
    const html = passwordResetTemplate.en(data, STORE);
    expect(html).toContain(data.resetUrl);
    expect(html).toContain('15 minutes');
  });

  it('ar body contains Arabic text, the reset URL, and an Arabic expiry — no leaked English', () => {
    const html = passwordResetTemplate.ar(data, STORE);
    expect(html).toContain('إعادة تعيين');
    expect(html).toContain(data.resetUrl);
    expect(html).toContain('15 دقيقة');
    // The bug this test now guards: the old template embedded the EN
    // template's own literal English phrase verbatim into Arabic copy.
    expect(html).not.toContain('minutes');
    expect(html).not.toContain('hour');
  });

  it('XSS in name escaped (en)', () => {
    const html = passwordResetTemplate.en({ ...data, name: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });

  it('XSS in name escaped (ar)', () => {
    const html = passwordResetTemplate.ar({ ...data, name: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// email-verification
// ---------------------------------------------------------------------------

describe('emailVerificationTemplate', () => {
  const data = {
    email: 'a@example.com',
    name: 'Ahmad',
    verificationUrl: 'https://store.test/verify?token=xyz',
    // #1860: a number, not a pre-formatted English phrase — see the ar-body
    // test below, which is the regression this replaces (password-reset.ts
    // got this fix earlier; the two verification templates did not).
    expiresInHours: 24,
  };

  it('en subject', () => {
    expect(emailVerificationTemplate.subject.en(data, STORE)).toBe('Verify Your Email Address');
  });

  it('ar subject', () => {
    expect(emailVerificationTemplate.subject.ar(data, STORE)).toContain('تأكيد بريدك');
  });

  it('en body has verify button link', () => {
    const html = emailVerificationTemplate.en(data, STORE);
    expect(html).toContain(data.verificationUrl);
    expect(html).toContain('24 hours');
  });

  it('ar body has Arabic text, the verification URL, and an Arabic expiry — no leaked English', () => {
    const html = emailVerificationTemplate.ar(data, STORE);
    expect(html).toContain('تأكيد');
    expect(html).toContain(data.verificationUrl);
    expect(html).toContain('24 ساعة');
    // The bug this test guards: the old template embedded the EN template's
    // own literal English phrase ("24 hours") verbatim into Arabic copy —
    // sent on every registration and every resend, to every Arabic-locale
    // shopper on every store.
    expect(html).not.toContain('hours');
    expect(html).not.toContain('hour');
  });

  it('XSS in verificationUrl escaped (en)', () => {
    const html = emailVerificationTemplate.en(
      { ...data, verificationUrl: 'https://store.test/verify?a=' + XSS },
      STORE
    );
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// resend-verification
// ---------------------------------------------------------------------------

describe('resendVerificationTemplate', () => {
  const data = {
    email: 'a@example.com',
    name: 'Fatima',
    verificationUrl: 'https://store.test/verify?token=new',
    // #1860: same fix as emailVerificationTemplate — a number, not a
    // pre-formatted English phrase.
    expiresInHours: 2,
  };

  it('en subject includes "New Link"', () => {
    expect(resendVerificationTemplate.subject.en(data, STORE)).toContain('New Link');
  });

  it('ar subject contains Arabic for new link', () => {
    expect(resendVerificationTemplate.subject.ar(data, STORE)).toContain('رابط جديد');
  });

  it('en body has verification URL', () => {
    const html = resendVerificationTemplate.en(data, STORE);
    expect(html).toContain(data.verificationUrl);
    expect(html).toContain('Fatima');
  });

  it('ar body has Arabic text, URL, and an Arabic expiry — no leaked English', () => {
    const html = resendVerificationTemplate.ar(data, STORE);
    expect(html).toContain('رابط');
    expect(html).toContain(data.verificationUrl);
    expect(html).toContain('2 ساعة');
    expect(html).not.toContain('hours');
    expect(html).not.toContain('hour');
  });

  it('XSS in name escaped (ar)', () => {
    const html = resendVerificationTemplate.ar({ ...data, name: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// duplicate-registration
// ---------------------------------------------------------------------------

describe('duplicateRegistrationTemplate', () => {
  const data = { email: 'a@example.com', name: 'Ahmad', storeName: STORE };

  it('en subject includes store name', () => {
    expect(duplicateRegistrationTemplate.subject.en(data, STORE)).toContain(STORE);
    expect(duplicateRegistrationTemplate.subject.en(data, STORE)).toContain('already exists');
  });

  it('ar subject includes store name in Arabic', () => {
    expect(duplicateRegistrationTemplate.subject.ar(data, STORE)).toContain('حساب مسبقاً');
    expect(duplicateRegistrationTemplate.subject.ar(data, STORE)).toContain(STORE);
  });

  it('en subject without storeName falls back to generic', () => {
    expect(duplicateRegistrationTemplate.subject.en({ ...data, storeName: undefined }, STORE)).toBe(
      'Account already exists'
    );
  });

  it('ar subject without storeName', () => {
    expect(duplicateRegistrationTemplate.subject.ar({ ...data, storeName: undefined }, STORE)).toBe(
      'لديك حساب مسبقاً'
    );
  });

  it('en body has sign-in link', () => {
    const html = duplicateRegistrationTemplate.en(data, STORE, WEB_URL);
    expect(html).toContain('/auth/login');
    expect(html).toContain('Ahmad');
  });

  it('ar body has Arabic text and sign-in link', () => {
    const html = duplicateRegistrationTemplate.ar(data, STORE, WEB_URL);
    expect(html).toContain('لديك حساب');
    expect(html).toContain('/auth/login');
  });

  it('XSS in name escaped (en)', () => {
    const html = duplicateRegistrationTemplate.en({ ...data, name: XSS }, STORE, WEB_URL);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// order-confirmation
// ---------------------------------------------------------------------------

const orderData = {
  orderNumber: 'ORD-001',
  customerName: 'Ahmad',
  customerEmail: 'a@example.com',
  items: [{ name: 'Widget', quantity: 2, price: 1500 }],
  subtotal: 3000,
  tax: 150,
  shipping: 500,
  total: 3650,
  shippingAddress: {
    firstName: 'Ahmad',
    lastName: 'S',
    address1: '1 Main St',
    city: 'Kuwait City',
    state: 'KW',
    postalCode: '12345',
    country: 'Kuwait',
  },
};

describe('orderConfirmationTemplate', () => {
  it('en subject contains order number', () => {
    expect(orderConfirmationTemplate.subject.en(orderData, STORE)).toContain('ORD-001');
    expect(orderConfirmationTemplate.subject.en(orderData, STORE)).toContain('Order Confirmed');
  });

  it('ar subject contains order number and Arabic text', () => {
    expect(orderConfirmationTemplate.subject.ar(orderData, STORE)).toContain('ORD-001');
    expect(orderConfirmationTemplate.subject.ar(orderData, STORE)).toContain('تم تأكيد');
  });

  it('en body uses KWD currency', () => {
    const html = orderConfirmationTemplate.en(orderData, STORE);
    expect(html).toContain('KWD');
    expect(html).not.toContain('د.ك');
  });

  it('ar body uses Arabic currency symbol', () => {
    const html = orderConfirmationTemplate.ar(orderData, STORE);
    expect(html).toContain('د.ك');
    expect(html).not.toContain(' KWD');
  });

  it('en body has Shipping Address label', () => {
    const html = orderConfirmationTemplate.en(orderData, STORE);
    expect(html).toContain('Shipping Address');
  });

  it('ar body has Arabic Shipping Address label', () => {
    const html = orderConfirmationTemplate.ar(orderData, STORE);
    expect(html).toContain('عنوان الشحن');
  });

  it('item name is escaped in both languages', () => {
    const d = { ...orderData, items: [{ name: XSS, quantity: 1, price: 1000 }] };
    expect(orderConfirmationTemplate.en(d, STORE)).not.toContain('<script>');
    expect(orderConfirmationTemplate.ar(d, STORE)).not.toContain('<script>');
  });

  it('total formatted correctly (en)', () => {
    const html = orderConfirmationTemplate.en(orderData, STORE);
    // 3650 fils = 3.650 KWD
    expect(html).toContain('3.650');
  });

  it('discount row shows the coupon code when a coupon applied (en)', () => {
    const d = { ...orderData, discount: 300, couponCode: 'SAVE10' };
    const html = orderConfirmationTemplate.en(d, STORE);
    expect(html).toContain('Discount (SAVE10)');
    expect(html).toContain('0.300');
  });

  it('discount row names the promotion when no coupon code is set (en)', () => {
    const d = { ...orderData, discount: 300, promotionName: 'Summer Sale' };
    const html = orderConfirmationTemplate.en(d, STORE);
    expect(html).toContain('Discount (Summer Sale)');
  });

  it('discount row names the promotion when no coupon code is set (ar, prefers nameAr)', () => {
    const d = {
      ...orderData,
      discount: 300,
      promotionName: 'Summer Sale',
      promotionNameAr: 'تخفيضات الصيف',
    };
    const html = orderConfirmationTemplate.ar(d, STORE);
    expect(html).toContain('تخفيضات الصيف');
    expect(html).not.toContain('Summer Sale');
  });

  it('coupon code takes priority over promotionName when both are set', () => {
    const d = { ...orderData, discount: 300, couponCode: 'SAVE10', promotionName: 'Summer Sale' };
    const html = orderConfirmationTemplate.en(d, STORE);
    expect(html).toContain('Discount (SAVE10)');
    expect(html).not.toContain('Summer Sale');
  });
});

// ---------------------------------------------------------------------------
// payment-success
// ---------------------------------------------------------------------------

describe('paymentSuccessTemplate', () => {
  it('en subject', () => {
    expect(paymentSuccessTemplate.subject.en(orderData, STORE)).toContain('Payment Received');
  });

  it('ar subject', () => {
    expect(paymentSuccessTemplate.subject.ar(orderData, STORE)).toContain('تم استلام الدفعة');
  });

  it('en body contains KWD total', () => {
    const html = paymentSuccessTemplate.en(orderData, STORE);
    expect(html).toContain('KWD');
    expect(html).toContain('3.650');
  });

  it('ar body contains Arabic currency', () => {
    const html = paymentSuccessTemplate.ar(orderData, STORE);
    expect(html).toContain('د.ك');
  });

  it('XSS in customerName escaped (en)', () => {
    const d = { ...orderData, customerName: XSS };
    expect(paymentSuccessTemplate.en(d, STORE)).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// payment-failed
// ---------------------------------------------------------------------------

describe('paymentFailedTemplate', () => {
  const data = {
    customerEmail: 'a@example.com',
    customerName: 'Ahmad',
    orderNumber: 'ORD-002',
    reason: 'Insufficient funds',
  };

  it('en subject', () => {
    expect(paymentFailedTemplate.subject.en(data, STORE)).toContain('Payment Failed');
  });

  it('ar subject', () => {
    expect(paymentFailedTemplate.subject.ar(data, STORE)).toContain('فشلت عملية الدفع');
  });

  it('en body shows reason', () => {
    const html = paymentFailedTemplate.en(data, STORE, WEB_URL);
    expect(html).toContain('Insufficient funds');
  });

  it('ar body shows reason and Arabic text', () => {
    const html = paymentFailedTemplate.ar(data, STORE, WEB_URL);
    expect(html).toContain('السبب');
    expect(html).toContain('Insufficient funds');
  });

  it('XSS in reason escaped (ar)', () => {
    const html = paymentFailedTemplate.ar({ ...data, reason: XSS }, STORE, WEB_URL);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// order-shipped
// ---------------------------------------------------------------------------

describe('orderShippedTemplate', () => {
  const data = {
    customerEmail: 'a@example.com',
    customerName: 'Ahmad',
    orderNumber: 'ORD-003',
    trackingNumber: 'TRK123',
    trackingUrl: 'https://courier.test/track/TRK123',
    carrier: 'Aramex',
  };

  it('en subject', () => {
    expect(orderShippedTemplate.subject.en(data, STORE)).toContain('Has Shipped');
  });

  it('ar subject', () => {
    expect(orderShippedTemplate.subject.ar(data, STORE)).toContain('تم شحن');
  });

  it('en body has tracking number and carrier', () => {
    const html = orderShippedTemplate.en(data, STORE);
    expect(html).toContain('TRK123');
    expect(html).toContain('Aramex');
  });

  it('ar body has Arabic text and tracking number', () => {
    const html = orderShippedTemplate.ar(data, STORE);
    expect(html).toContain('رقم التتبع');
    expect(html).toContain('TRK123');
  });

  it('en body has Track Order button', () => {
    const html = orderShippedTemplate.en(data, STORE);
    expect(html).toContain(data.trackingUrl);
    expect(html).toContain('Track Order');
  });

  it('ar body has Arabic track button', () => {
    const html = orderShippedTemplate.ar(data, STORE);
    expect(html).toContain('تتبع الطلب');
  });

  it('XSS in trackingNumber escaped (en)', () => {
    const html = orderShippedTemplate.en({ ...data, trackingNumber: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// return-confirmation
// ---------------------------------------------------------------------------

describe('returnConfirmationTemplate', () => {
  const data = {
    email: 'a@example.com',
    customerName: 'Ahmad',
    storeName: STORE,
    returnNumber: 'RET-001',
    orderNumber: 'ORD-001',
    type: 'return',
  };

  it('en subject for return type', () => {
    expect(returnConfirmationTemplate.subject.en(data, STORE)).toContain('Return Request Received');
  });

  it('en subject for exchange type', () => {
    expect(returnConfirmationTemplate.subject.en({ ...data, type: 'exchange' }, STORE)).toContain(
      'Exchange Request Received'
    );
  });

  it('ar subject for refund type contains Arabic', () => {
    expect(returnConfirmationTemplate.subject.ar({ ...data, type: 'refund' }, STORE)).toContain(
      'تم استلام طلب الاسترداد'
    );
  });

  it('en body has return number', () => {
    const html = returnConfirmationTemplate.en(data, STORE);
    expect(html).toContain('RET-001');
    expect(html).toContain('ORD-001');
  });

  it('ar body has Arabic text and return number', () => {
    const html = returnConfirmationTemplate.ar(data, STORE);
    expect(html).toContain('شكراً لصبرك');
    expect(html).toContain('RET-001');
  });

  it('XSS in customerName escaped (ar)', () => {
    const html = returnConfirmationTemplate.ar({ ...data, customerName: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });
});

// ---------------------------------------------------------------------------
// return-status-update
// ---------------------------------------------------------------------------

describe('returnStatusUpdateTemplate', () => {
  const data = {
    email: 'a@example.com',
    customerName: 'Ahmad',
    storeName: STORE,
    returnNumber: 'RET-002',
    status: 'approved',
  };

  it('en subject', () => {
    expect(returnStatusUpdateTemplate.subject.en(data, STORE)).toContain('Return Status Update');
  });

  it('ar subject', () => {
    expect(returnStatusUpdateTemplate.subject.ar(data, STORE)).toContain('تحديث الحالة');
  });

  it('en body has approved message', () => {
    const html = returnStatusUpdateTemplate.en(data, STORE);
    expect(html).toContain('approved');
    expect(html).toContain('RET-002');
  });

  it('ar body has Arabic approved message', () => {
    const html = returnStatusUpdateTemplate.ar(data, STORE);
    expect(html).toContain('الموافقة');
    expect(html).toContain('RET-002');
  });

  it('notes rendered when present (en)', () => {
    const html = returnStatusUpdateTemplate.en({ ...data, notes: 'Please repackage.' }, STORE);
    expect(html).toContain('Please repackage.');
  });

  it('notes rendered when present (ar)', () => {
    const html = returnStatusUpdateTemplate.ar({ ...data, notes: 'أعد التغليف.' }, STORE);
    expect(html).toContain('أعد التغليف.');
  });

  it('XSS in notes escaped (en)', () => {
    const html = returnStatusUpdateTemplate.en({ ...data, notes: XSS }, STORE);
    expect(html).not.toContain('<script>');
  });
});
