// @vitest-environment jsdom
/** On a demo store the pay action is replaced by the closed-ordering notice. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
  translations: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import PaymentStep from './PaymentStep';

afterEach(cleanup);

const props = {
  formData: {} as never,
  onEditShipping: () => {},
  paymentProviders: [],
  selectedProvider: 'cod',
  onSelectProvider: () => {},
  isProcessing: false,
  total: 10000,
  formatPrice: (n: number) => String(n),
};

describe('PaymentStep on a demo store', () => {
  it('shows the notice and no submit button', () => {
    const { container, getByText } = render(<PaymentStep {...props} isDemo />);
    expect(getByText('ده متجر تجريبي — الطلبات مقفولة')).toBeTruthy();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    // No payment-method card (nothing to choose) and no "contact the owner" alert: the demo
    // notice is the answer.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('طريقة الدفع');
    expect(container.textContent).not.toContain('اختر طريقة الدفع المفضلة');
  });
  it('a demo store whose payment config failed still shows the error and its retry', () => {
    const { container, getByText } = render(
      <PaymentStep {...props} isDemo paymentConfigError onRetryPaymentConfig={() => {}} />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'معرفناش نحمّل طرق الدفع'
    );
    expect(getByText('إعادة المحاولة')).toBeTruthy();
    expect(getByText('ده متجر تجريبي — الطلبات مقفولة')).toBeTruthy();
  });
  it('a normal store keeps the pay button and no notice', () => {
    const { container } = render(<PaymentStep {...props} />);
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();
    expect(container.querySelector('[data-demo-checkout-notice]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('طرق دفع');
    expect(container.textContent).toContain('طريقة الدفع');
  });
  it('a gold cart with nothing but deferred methods says it must be paid online, and cannot be placed', () => {
    const { container } = render(
      <PaymentStep {...props} selectedProvider="" goldNeedsOnlinePayment />
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('لازم يتدفع أونلاين');
    expect(container.textContent).not.toContain('مفيش طرق دفع');
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
  });
});
