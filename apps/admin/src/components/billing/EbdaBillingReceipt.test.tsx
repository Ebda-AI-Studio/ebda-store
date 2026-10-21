// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BRAND, billingPaymentNumber } from '@ebda/shared';

vi.mock('../../i18n/useT', () => ({
  useT: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${Object.values(v).join(',')}` : key,
}));

import { EbdaBillingReceipt } from './EbdaBillingReceipt';

const charge0 = {
  id: '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d',
  planCode: 'growth',
  amountMinor: 49900,
  createdAt: '2026-10-21T10:00:00Z',
};

const charge = charge0;
const NUMBER = billingPaymentNumber(charge0.id);

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe('EbdaBillingReceipt', () => {
  it('prints the palm-shaped Code 128 of the payment number, LTR, in Ebda colours', () => {
    const { container } = render(<EbdaBillingReceipt charge={charge} locale="en" />);
    expect(screen.getByTestId('ebda-receipt-number').textContent).toBe(NUMBER);
    expect(container.querySelector(`bdi[dir="ltr"] svg[aria-label="${NUMBER}"]`)).toBeTruthy();
    expect(container.querySelector('mask#bcm-palm')).toBeTruthy();
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain('#ff6e01');
    expect(html).toContain(BRAND.colors.night.toLowerCase());
  });
  it('reuses the shared printer: feeds once, then settles on "paid"', () => {
    render(<EbdaBillingReceipt charge={charge} locale="en" />);
    expect(screen.getByTestId('ebda-receipt-paper').getAttribute('data-feeding')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('printing');
  });
  it('under reduced motion it is a static receipt, already paid', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} })) as never;
    render(<EbdaBillingReceipt charge={charge} locale="ar" />);
    expect(screen.getByTestId('ebda-receipt-paper').getAttribute('data-feeding')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('paid');
    expect(screen.getAllByText(BRAND.nameAr).length).toBeGreaterThan(0);
  });
});
