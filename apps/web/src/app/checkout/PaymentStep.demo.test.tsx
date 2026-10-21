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
  });
  it('a normal store keeps the pay button and no notice', () => {
    const { container } = render(<PaymentStep {...props} />);
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();
    expect(container.querySelector('[data-demo-checkout-notice]')).toBeNull();
  });
});
