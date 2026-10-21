// @vitest-environment jsdom
/**
 * B2B review I2 / M1 / M6 on the account page: an approved buyer sees the wholesale-only catalogue, the apply form needs the
 * consent box before it can be sent (and sends `consent: true`), and its inputs are at least 44px tall.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  products: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getWholesaleStatus: h.status,
    getWholesaleProducts: h.products,
    applyForWholesale: h.apply,
  },
}));
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en' }),
}));
vi.mock('../../../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n}`,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

import WholesaleClient from './WholesaleClient';

beforeEach(() => {
  h.status.mockReset();
  h.products.mockReset();
  h.apply.mockReset();
});
afterEach(cleanup);

describe('WholesaleClient', () => {
  it('an approved buyer sees the wholesale-only catalogue with a link to each product', async () => {
    h.status.mockResolvedValue({
      success: true,
      data: { isWholesale: true, application: { status: 'approved', businessName: 'X' } },
    });
    h.products.mockResolvedValue({
      success: true,
      data: { products: [{ id: 'p1', name: 'Bulk tea', slug: 'bulk-tea', price: 8000, moq: 12 }] },
    });
    render(<WholesaleClient />);
    const catalog = await screen.findByTestId('wholesale-catalog');
    expect(catalog.textContent).toContain('Bulk tea');
    expect(catalog.textContent).toContain('minimum order 12');
    expect(catalog.querySelector('a')?.getAttribute('href')).toBe('/products/bulk-tea');
  });

  it('a non-member never requests the catalogue', async () => {
    h.status.mockResolvedValue({ success: true, data: { isWholesale: false, application: null } });
    render(<WholesaleClient />);
    await screen.findByTestId('wholesale-account');
    expect(h.products).not.toHaveBeenCalled();
  });

  it('the apply button stays disabled until the consent box is ticked, then sends consent: true; inputs are 44px+', async () => {
    h.status.mockResolvedValue({ success: true, data: { isWholesale: false, application: null } });
    h.apply.mockResolvedValue({
      success: true,
      data: { application: { id: 'a', status: 'pending' } },
    });
    render(<WholesaleClient />);
    await screen.findByTestId('wholesale-consent');
    const submit = screen.getByRole('button', {
      name: /apply for a wholesale account/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const input of document.querySelectorAll(
      'input[type="text"], input:not([type]), input[type="tel"], textarea'
    )) {
      expect(input.className, 'input is at least 44px tall').toContain('min-h-11');
    }
    const [name, , phone] = Array.from(
      document.querySelectorAll('input:not([type="checkbox"])')
    ) as HTMLInputElement[];
    fireEvent.change(name!, { target: { value: 'Cairo Traders' } });
    fireEvent.change(phone!, { target: { value: '+201000000123' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() => expect(h.apply).toHaveBeenCalled());
    expect(h.apply.mock.calls[0]![0]).toMatchObject({
      businessName: 'Cairo Traders',
      consent: true,
    });
  });

  it('approved but the group is paused: says so instead of rendering only a heading', async () => {
    h.status.mockResolvedValue({
      success: true,
      data: { isWholesale: false, application: { status: 'approved', businessName: 'X' } },
    });
    render(<WholesaleClient />);
    expect((await screen.findByTestId('wholesale-account')).textContent).toContain('paused');
  });
});
