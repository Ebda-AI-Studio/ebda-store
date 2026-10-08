// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { locale } = vi.hoisted(() => ({ locale: { current: 'en' } }));
vi.mock('next-intl', () => ({ useLocale: () => locale.current }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { UpsellDialog, billingHref } from './UpsellDialog';

afterEach(() => {
  cleanup();
  locale.current = 'en';
  window.history.replaceState(null, '', '/');
});

function fire(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent('ebda:upsell', { detail }));
  });
}

describe('UpsellDialog', () => {
  it('stays hidden until an upsell event, then shows the localized message and an upgrade link to this store', () => {
    window.history.replaceState(null, '', '/stores/abc-123/products');
    render(<UpsellDialog />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fire({
      code: 'PLAN_LIMIT_REACHED',
      message: 'You reached your product limit.',
      upgradeTo: { code: 'growth', nameEn: 'Growth', nameAr: 'النمو' },
      limitKey: 'maxProducts',
    });
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('You reached your product limit.');
    const link = screen.getByRole('link', { name: 'upgradeTo:{"plan":"Growth"}' });
    expect(link.getAttribute('href')).toBe('/stores/abc-123/billing?plan=growth#plans');
  });

  it('names the plan in the Arabic UI and falls back to "See plans" with no target', () => {
    locale.current = 'ar';
    window.history.replaceState(null, '', '/stores/s1/orders');
    render(<UpsellDialog />);
    fire({
      code: 'STORE_OVER_PLAN_LIMIT',
      message: 'x',
      upgradeTo: { code: 'business', nameEn: 'Business', nameAr: 'الأعمال' },
      limitKey: null,
    });
    expect(screen.getByRole('link').textContent).toBe('upgradeTo:{"plan":"الأعمال"}');
    cleanup();

    render(<UpsellDialog />);
    fire({
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Subscribe first',
      upgradeTo: null,
      limitKey: null,
    });
    const link = screen.getByRole('link', { name: 'seePlans' });
    expect(link.getAttribute('href')).toBe('/stores/s1/billing#plans');
  });

  it('falls back to /stores outside a store page, and dismisses with the button or Escape', () => {
    window.history.replaceState(null, '', '/dashboard');
    render(<UpsellDialog />);
    fire({ code: 'STORE_LIMIT_REACHED', message: 'm', upgradeTo: 'business', limitKey: null });
    expect(screen.getByRole('link').getAttribute('href')).toBe('/stores');
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fire({ code: 'STORE_LIMIT_REACHED', message: 'm', upgradeTo: null, limitKey: null });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('ignores 402s the calling screen already explains inline (go-live codes)', () => {
    render(<UpsellDialog />);
    fire({ code: 'PAYMENT_METHOD_REQUIRED', message: 'm', upgradeTo: null, limitKey: null });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('billingHref parses the store id from the path', () => {
    expect(billingHref('/stores/xyz/settings/payments', 'growth')).toBe(
      '/stores/xyz/billing?plan=growth#plans'
    );
    expect(billingHref('/stores/xyz', null)).toBe('/stores/xyz/billing#plans');
    expect(billingHref('/login', 'growth')).toBe('/stores');
  });
});
