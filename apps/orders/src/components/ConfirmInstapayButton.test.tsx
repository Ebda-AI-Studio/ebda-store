// @vitest-environment jsdom
/**
 * SP6a - the one-thumb "Payment received" control of the orders PWA. A big button
 * opens a bottom sheet that restates the exact amount; only the sheet's confirm
 * calls the API, and it calls it once even if tapped twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  apiPost: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ apiPost: (...a: unknown[]) => h.apiPost(...a) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ notify: h.notify }) }));
vi.mock('@/lib/format', () => ({
  formatMoney: (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`,
}));
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    t: {
      instapay: {
        confirm: 'Payment received',
        sheetTitle: 'Did the transfer arrive?',
        sheetBody: 'Confirm only if you can see {amount} in your InstaPay account.',
        sheetYes: 'Yes, payment received',
        sheetNo: 'Not yet',
        confirmed: 'Payment confirmed',
        alreadyConfirmed: 'Already confirmed',
        failed: 'Could not confirm the payment',
        expired: 'The confirmation window has expired',
      },
    },
  }),
}));

import { ConfirmInstapayButton } from './ConfirmInstapayButton';

beforeEach(() => {
  h.apiPost.mockReset().mockResolvedValue({ data: { changed: true }, error: null });
  h.notify.mockReset();
});
afterEach(() => cleanup());

const renderButton = (onConfirmed = vi.fn()) => {
  render(
    <ConfirmInstapayButton
      storeId="s1"
      orderId="o1"
      amountMinor={12345}
      currency="EGP"
      onConfirmed={onConfirmed}
    />
  );
  return onConfirmed;
};

describe('ConfirmInstapayButton', () => {
  it('is a big (>= 48px) tap target and calls nothing until the sheet is confirmed', () => {
    renderButton();
    const btn = screen.getByTestId('confirm-instapay');
    expect(btn.className).toContain('min-h-12');
    fireEvent.click(btn);
    expect(h.apiPost).not.toHaveBeenCalled();
    // the sheet restates the exact amount
    expect(screen.getByText(/123\.45 EGP/)).toBeTruthy();
  });

  it('"Not yet" closes the sheet without confirming', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('confirm-instapay'));
    fireEvent.click(screen.getByText('Not yet'));
    expect(h.apiPost).not.toHaveBeenCalled();
    expect(screen.queryByText('Did the transfer arrive?')).toBeNull();
  });

  it('confirms once through the idempotent endpoint, refreshes, and ignores a double tap', async () => {
    const onConfirmed = renderButton();
    fireEvent.click(screen.getByTestId('confirm-instapay'));
    const yes = screen.getByText('Yes, payment received');
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(h.apiPost).toHaveBeenCalledTimes(1);
    expect(h.apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/confirm-instapay', {});
    expect(h.notify).toHaveBeenCalledWith('Payment confirmed', 'success');
  });

  it('says "already confirmed" when the server answers changed:false', async () => {
    h.apiPost.mockResolvedValue({ data: { changed: false }, error: null });
    renderButton();
    fireEvent.click(screen.getByTestId('confirm-instapay'));
    fireEvent.click(screen.getByText('Yes, payment received'));
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith('Already confirmed', 'success'));
  });

  it('explains an expired window instead of a generic failure', async () => {
    h.apiPost.mockResolvedValue({
      data: null,
      error: { code: 'INSTAPAY_CONFIRMATION_EXPIRED', message: 'expired' },
    });
    renderButton();
    fireEvent.click(screen.getByTestId('confirm-instapay'));
    fireEvent.click(screen.getByText('Yes, payment received'));
    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith('The confirmation window has expired', 'error')
    );
  });
});
