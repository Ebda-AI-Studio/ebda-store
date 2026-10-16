// @vitest-environment jsdom
/**
 * IA-01 (independent audit, P1): the "Shipping to" review read `formData.address`, which the
 * structured Egyptian form never fills, so the street line was blank at the last step before an
 * irreversible COD order, and the area showed its English name on an Arabic page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

let lang: 'ar' | 'en' = 'ar';
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
  translations: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import PaymentStep from './PaymentStep';
import { shippingSummaryLines } from './_lib/shippingSummary';

afterEach(() => {
  cleanup();
  lang = 'ar';
});

const formData = {
  email: '',
  firstName: 'منى',
  lastName: 'سالم',
  phone: '01012345678',
  governorate: 'Cairo',
  area: 'Nasr City',
  street: 'شارع عباس العقاد',
  building: '12',
  floor: '3',
  apartment: '7',
  landmark: '',
  notes: '',
  address: '',
};
const names = {
  area: { en: 'Nasr City', ar: 'مدينة نصر' },
  governorate: { en: 'Cairo', ar: 'القاهرة' },
};

describe('shippingSummaryLines', () => {
  it('ar: street + building/floor/apt in Arabic labels, the area and governorate in Arabic', () => {
    expect(shippingSummaryLines(formData, names, 'ar')).toEqual([
      'منى سالم',
      'شارع عباس العقاد، مبنى 12، الدور 3، شقة 7',
      'مدينة نصر، القاهرة',
      '01012345678',
    ]);
  });
  it('en: English labels and names', () => {
    expect(shippingSummaryLines(formData, names, 'en')[1]).toBe(
      'شارع عباس العقاد, Building 12, Floor 3, Apt 7'
    );
    expect(shippingSummaryLines(formData, names, 'en')[2]).toBe('Nasr City, Cairo');
  });
  it('no localized name known: the canonical value, never a blank line', () => {
    expect(shippingSummaryLines(formData, {}, 'ar')[2]).toBe('Nasr City، Cairo');
  });
});

describe('PaymentStep "Shipping to" card', () => {
  it('shows the street and the Arabic area', () => {
    const { getByTestId } = render(
      <PaymentStep
        formData={formData as never}
        shippingNames={names}
        onEditShipping={() => {}}
        paymentProviders={[]}
        selectedProvider="cod"
        onSelectProvider={() => {}}
        isProcessing={false}
        total={10000}
        formatPrice={n => String(n)}
      />
    );
    const card = getByTestId('shipping-summary').textContent ?? '';
    expect(card).toContain('شارع عباس العقاد');
    expect(card).toContain('مدينة نصر');
    expect(card).not.toContain('Nasr City');
  });
});

// a11y re-audit P1-N4 (rule (d)): on step 2 the Edit link measured 20px high and the payment
// retry button 28px; the step indicator button 32px and the error Dismiss 16x16 (checked below).
describe('step 2 controls are 44px targets (P1-N4)', () => {
  it('Edit, the payment choices and Retry', async () => {
    const { smallTargets } = await import('../../../../../tests/helpers/target-size');
    const { container } = render(
      <PaymentStep
        formData={formData as never}
        shippingNames={names}
        onEditShipping={() => {}}
        paymentProviders={[]}
        selectedProvider="cod"
        onSelectProvider={() => {}}
        isProcessing={false}
        total={10000}
        formatPrice={n => String(n)}
        paymentConfigError
        onRetryPaymentConfig={() => {}}
      />
    );
    expect(smallTargets(container, 44, { requireWidth: true })).toEqual([]);
  });
  it('the checkout step button and the error Dismiss carry a 44px box', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const client = readFileSync(join(__dirname, 'CheckoutClient.tsx'), 'utf8');
    const steps = [...client.matchAll(/disabled=\{step <= \d\}\n\s*className=\{`([^`]*)/g)];
    expect(steps.length).toBeGreaterThan(0);
    for (const m of steps) expect(m[1]).toMatch(/min-h-11/);
    const alert = readFileSync(join(__dirname, 'CheckoutErrorAlert.tsx'), 'utf8');
    expect(alert).toMatch(
      /aria-label=\{t\('Dismiss', 'إغلاق'\)\}\n\s*className="[^"]*\bh-11 w-11\b/
    );
  });
});
