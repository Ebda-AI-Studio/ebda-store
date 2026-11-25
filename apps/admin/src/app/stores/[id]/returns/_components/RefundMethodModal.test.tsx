// @vitest-environment jsdom
/**
 * The refund-method dialog is where a merchant's click turns into a real,
 * irreversible provider refund, so its guards are money guards (#1485, #1474):
 *
 *   - nothing is preselected — "Original payment method" used to be the
 *     default, so the default click sent money the merchant never saw;
 *   - each option shows the amount it would send or record, from the API's
 *     refund preview, never the creation-time estimate;
 *   - "Original payment method" is disabled, with the reason, when the order
 *     cannot take a gateway refund (cash on delivery, fully refunded, …);
 *   - nothing is sent until a second, explicit confirmation of the amount;
 *   - "Already refunded — record only" appears only when a refund for this
 *     return already went to the provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const apiGet = vi.fn();
vi.mock('../../../../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

import { RefundMethodModal } from './RefundMethodModal';

type Gateway = {
  available: boolean;
  amount: number | null;
  refundableRemaining: number | null;
  unavailableReason: string | null;
  alreadyPaidToCustomer?: boolean;
};

function previewWith(gateway: Gateway, recordedAmount = 1978) {
  apiGet.mockResolvedValue({
    data: { preview: { isFullReturn: false, recordedAmount, gateway } },
    error: null,
  });
}

const GATEWAY_OK: Gateway = {
  available: true,
  amount: 1978,
  refundableRemaining: 8900,
  unavailableReason: null,
};

function renderModal(onConfirm = vi.fn(), guestReturn = false) {
  render(
    <RefundMethodModal
      open
      guestReturn={guestReturn}
      storeId="store-1"
      returnId="ret-1"
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />
  );
  return onConfirm;
}

const radio = (value: string) =>
  document.querySelector(`input[name="refundMethod"][value="${value}"]`) as HTMLInputElement | null;

beforeEach(() => {
  apiGet.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('RefundMethodModal', () => {
  it('preselects nothing, and Continue needs a choice', async () => {
    previewWith(GATEWAY_OK);
    renderModal();
    await waitFor(() => expect(radio('original')?.disabled).toBe(false));

    for (const v of ['original', 'store_credit', 'bank_transfer']) {
      expect(radio(v)?.checked, `${v} must not be preselected`).toBe(false);
    }
    expect((screen.getByRole('button', { name: 'continue' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('loads the preview for THIS return and shows the amount each option moves', async () => {
    previewWith(GATEWAY_OK, 1978);
    renderModal();

    await waitFor(() => expect(screen.getAllByText(/19\.78/).length).toBeGreaterThanOrEqual(3));
    expect(apiGet).toHaveBeenCalledWith(
      '/api/v1/stores/store-1/returns/admin/ret-1/refund-preview'
    );
  });

  it('disables the original payment method, with the reason, for a COD order', async () => {
    previewWith({
      available: false,
      amount: null,
      refundableRemaining: null,
      unavailableReason: 'NO_COMPLETED_PAYMENT',
    });
    renderModal();

    await waitFor(() =>
      expect(screen.getByText('gatewayUnavailable.NO_COMPLETED_PAYMENT')).toBeTruthy()
    );
    expect(radio('original')?.disabled).toBe(true);
    expect(radio('bank_transfer')?.disabled).toBe(false);
  });

  it('never offers the gateway when the preview could not load', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'x', status: 500 },
    });
    renderModal();

    await waitFor(() => expect(screen.getByText('previewError')).toBeTruthy());
    expect(radio('original')?.disabled).toBe(true);
  });

  it('sends nothing until the amount is confirmed on the second step', async () => {
    previewWith(GATEWAY_OK);
    const onConfirm = renderModal();
    await waitFor(() => expect(radio('original')?.disabled).toBe(false));

    fireEvent.click(radio('original')!);
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    expect(onConfirm, 'choosing is not confirming').not.toHaveBeenCalled();
    expect(screen.getByText(/confirmOriginal .*19\.78/)).toBeTruthy();
    expect(screen.getByText('confirmIrreversible')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'confirmSendRefund' }));
    expect(onConfirm).toHaveBeenCalledWith('original');
  });

  it('offers "record only" only when a refund for this return already went out', async () => {
    previewWith(GATEWAY_OK);
    renderModal();
    await waitFor(() => expect(radio('original')?.disabled).toBe(false));
    expect(radio('manual'), 'hidden in the normal case').toBeNull();
    cleanup();

    previewWith({
      available: false,
      amount: null,
      refundableRemaining: 3000,
      unavailableReason: 'REFUND_ALREADY_ISSUED',
    });
    renderModal();
    await waitFor(() => expect(radio('manual')).not.toBeNull());
    expect(radio('original')?.disabled).toBe(true);
    expect(screen.getByText('alreadyIssuedNotice')).toBeTruthy();
  });

  it('issue 2003 — also offers "record only" when the payment was refunded in full elsewhere', async () => {
    previewWith({
      available: false,
      amount: null,
      refundableRemaining: 0,
      unavailableReason: 'PAYMENT_FULLY_REFUNDED',
      alreadyPaidToCustomer: true,
    });
    renderModal();
    await waitFor(() => expect(radio('manual')).not.toBeNull());
    expect(screen.getByText('alreadyFullyRefundedNotice')).toBeTruthy();
  });

  it('issue 2003 — never offers "record only" when money is still owed', async () => {
    previewWith({
      available: false,
      amount: null,
      refundableRemaining: 500,
      unavailableReason: 'PARTIAL_REFUND_EXCEEDS_PAYMENT',
      alreadyPaidToCustomer: false,
    });
    renderModal();
    await waitFor(() => expect(radio('original')?.disabled).toBe(true));
    expect(radio('manual')).toBeNull();
  });
  it('with the wallet on, store credit shows and confirms what the wallet receives', async () => {
    // A full return: the wallet gets cashCredit + shipping − walletAmount,
    // which is NOT the recorded figure. The merchant must confirm the former.
    apiGet.mockResolvedValue({
      data: {
        preview: {
          isFullReturn: true,
          recordedAmount: 9000,
          storeCreditToWallet: 7500,
          gateway: GATEWAY_OK,
        },
      },
      error: null,
    });
    const onConfirm = renderModal();
    await waitFor(() => expect(screen.getAllByText(/75\.00/).length).toBeGreaterThanOrEqual(1));

    fireEvent.click(radio('store_credit')!);
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    expect(screen.getByText(/confirmWallet .*75\.00/)).toBeTruthy();
    expect(screen.queryByText(/90\.00/), 'never the off-platform figure').toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'refundMethodConfirm' }));
    expect(onConfirm).toHaveBeenCalledWith('store_credit');
  });
});

describe('RefundMethodModal: tier adjustment (B2B Task 8b)', () => {
  const LINE = {
    returnItemId: 'ri-1',
    productName: 'Bulk tea',
    quantity: 90,
    keptQty: 10,
    tierMinQty: 100,
    standardRefund: 720000,
    adjustment: 20000,
    adjustedRefund: 700000,
    shortfall: 0,
    carriedIn: 0,
    keptUnitMinor: 10000,
    reason: 'kept_below_tier',
    overridden: false,
    overrideReason: null,
  };
  const withLines = (lines: unknown[]) =>
    apiGet.mockResolvedValue({
      data: {
        preview: {
          isFullReturn: false,
          recordedAmount: 700000,
          gateway: {
            available: true,
            amount: 700000,
            refundableRemaining: 900000,
            unavailableReason: null,
          },
          lines,
        },
      },
      error: null,
    });
  const toConfirm = async (onConfirm = vi.fn()) => {
    renderModal(onConfirm);
    await waitFor(() => expect(radio('bank_transfer')?.disabled).toBe(false));
    fireEvent.click(radio('bank_transfer')!);
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    return onConfirm;
  };

  it('shows the standard refund, the adjustment with its reason and the adjusted refund, in Latin digits', async () => {
    withLines([LINE]);
    await toConfirm();
    const box = screen.getByTestId('tier-adjustment');
    expect(box.textContent).toContain('7,200.00'); // standard
    expect(box.textContent).toContain('200.00'); // adjustment
    expect(box.textContent).toContain('7,000.00'); // adjusted
    expect(box.textContent).toContain('tierAdjustment.reason.kept_below_tier');
    expect(box.textContent).toContain('"kept":10');
    expect(box.textContent).toContain('"tier":100');
    expect(box.textContent).not.toMatch(/[٠-٩]/);
  });

  it('Ruling B2B-20: a carry collected here and a shortfall carried onward are both shown', async () => {
    withLines([{ ...LINE, carriedIn: 100000, shortfall: 50000 }]);
    await toConfirm();
    const box = screen.getByTestId('tier-adjustment');
    expect(box.textContent).toContain('tierAdjustment.carried');
    expect(box.textContent).toContain('1,000.00');
    expect(box.textContent).toContain('tierAdjustment.shortfall');
    expect(box.textContent).toContain('500.00');
  });

  it('is absent when no line is tier-priced (a plain partial return looks exactly as before)', async () => {
    withLines([{ ...LINE, adjustment: 0, reason: 'none', adjustedRefund: LINE.standardRefund }]);
    await toConfirm();
    expect(screen.queryByTestId('tier-adjustment')).toBeNull();
  });

  it('an override needs a valid amount and a reason, is re-previewed, and is sent with the confirm', async () => {
    withLines([LINE]);
    const onConfirm = await toConfirm();
    fireEvent.click(screen.getByLabelText('tierAdjustment.override'));
    const amount = screen.getByLabelText('tierAdjustment.overrideAmount') as HTMLInputElement;
    const reason = screen.getByLabelText('tierAdjustment.overrideReason') as HTMLInputElement;
    const confirmBtn = () =>
      screen.getByRole('button', { name: 'refundMethodConfirm' }) as HTMLButtonElement;

    fireEvent.change(amount, { target: { value: '7300' } }); // above the standard refund
    expect(screen.getByText(/tierAdjustment\.error\.amount/)).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.change(amount, { target: { value: '7100' } });
    expect(confirmBtn().disabled, 'a reason is required').toBe(true);
    fireEvent.change(reason, { target: { value: 'goodwill' } });
    expect(confirmBtn().disabled).toBe(false);

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('refund-preview?overrides='))
    );
    fireEvent.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith('bank_transfer', {
      'ri-1': { amountMinor: 710000, reason: 'goodwill' },
    });
  });

  it('a guest return: store credit is disabled with the reason, the other methods stay open', async () => {
    previewWith(GATEWAY_OK);
    renderModal(vi.fn(), true);
    await waitFor(() => expect(radio('original')?.disabled).toBe(false));
    expect(radio('store_credit')?.disabled).toBe(true);
    expect(screen.getByText('storeCreditNeedsAccount')).toBeTruthy();
  });

  it('an account return keeps store credit selectable', async () => {
    previewWith(GATEWAY_OK);
    renderModal();
    await waitFor(() => expect(radio('store_credit')?.disabled).toBe(false));
    expect(screen.queryByText('storeCreditNeedsAccount')).toBeNull();
  });
});
