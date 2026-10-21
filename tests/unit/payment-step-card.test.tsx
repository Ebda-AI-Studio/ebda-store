// @vitest-environment jsdom
/** B1-20: card + COD both render on a Qamar Lookbook store; Arabic card label; no sub-12px text. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
  translations: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import PaymentStep from '../../apps/web/src/app/checkout/PaymentStep';

afterEach(cleanup);

const providers = [
  { id: 'card', name: 'Card', nameAr: 'بطاقة بنكية', enabled: true },
  { id: 'cod', name: 'Cash on delivery', nameAr: 'الدفع عند الاستلام', enabled: true },
];

describe('PaymentStep with card + COD on a qamar.lookbook store', () => {
  it('renders both methods, Arabic card label, nothing under 12px', () => {
    const { container, getByText } = render(
      <div data-look="qamar.lookbook">
        <PaymentStep
          formData={{} as never}
          onEditShipping={() => {}}
          paymentProviders={providers}
          selectedProvider="cod"
          onSelectProvider={() => {}}
          isProcessing={false}
          total={10000}
          formatPrice={n => String(n)}
        />
      </div>
    );
    expect(container.querySelectorAll('input[name="paymentMethod"]')).toHaveLength(2);
    expect(getByText('بطاقة بنكية')).toBeTruthy();
    expect(getByText('الدفع عند الاستلام')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/text-\[\d+px\]/);
  });
});
