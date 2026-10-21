// @vitest-environment jsdom
/**
 * L-11 (W3): one share control. Where the device has a native share sheet (every phone browser),
 * one "Share" button opens it; elsewhere WhatsApp (how Egyptian shoppers share) and Copy link.
 * No tracked uppercase eyebrow, no row of four brand discs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: true, t: (_en: string, ar?: string) => ar ?? _en }),
}));
vi.mock('../../hooks/useCurrentUrl', () => ({
  useCurrentUrl: () => 'https://s.ebda.app/products/x',
}));
const { ShareProductRow } = await import('./ShareProductRow');

afterEach(() => {
  cleanup();
  delete (navigator as { share?: unknown }).share;
});

describe('ShareProductRow', () => {
  it('a device with a share sheet: ONE button, it opens the sheet with the product', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    (navigator as { share?: unknown }).share = share;
    const { container } = render(<ShareProductRow productName="عباية" />);
    await act(async () => {});
    const controls = container.querySelectorAll('a, button');
    expect(controls).toHaveLength(1);
    await act(async () => {
      fireEvent.click(controls[0]);
    });
    expect(share).toHaveBeenCalledWith({ title: 'عباية', url: 'https://s.ebda.app/products/x' });
  });
  it('no share sheet: WhatsApp and Copy link only', async () => {
    const { container } = render(<ShareProductRow productName="عباية" />);
    await act(async () => {});
    const labels = [...container.querySelectorAll('a, button')].map(e =>
      e.getAttribute('aria-label')
    );
    expect(labels).toEqual(['مشاركة على واتساب', 'نسخ الرابط']);
  });
  it('no tracked uppercase eyebrow', () => {
    const { container } = render(<ShareProductRow productName="x" />);
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-wider/);
  });
});
