// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MESSAGES } from '@/i18n/messages';

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: MESSAGES.en, locale: 'en' }),
}));

import { ManualRefundDialog } from './ManualRefundDialog';

afterEach(cleanup);
const ta = MESSAGES.en.detail.actions;

describe('ManualRefundDialog', () => {
  it('says the money must already be returned, none is sent, and the customer is told', () => {
    render(<ManualRefundDialog open onConfirm={async () => null} onClose={() => {}} />);
    expect(ta.manualRefundDesc).toMatch(
      /only after you have already given the customer their money back/
    );
    expect(ta.manualRefundDesc).toMatch(/told their refund was issued/);
    expect(ta.manualRefundDesc).toMatch(/does not send any money/);
    expect(screen.getByText(ta.manualRefundDesc)).toBeTruthy();
  });

  it('confirms with the chosen method and reference, then closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(null);
    const onClose = vi.fn();
    render(<ManualRefundDialog open onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(ta.manualRefundMethodLabel), {
      target: { value: 'bank_transfer' },
    });
    fireEvent.change(screen.getByLabelText(ta.manualRefundReferenceLabel), {
      target: { value: 'TRX-9' },
    });
    fireEvent.click(screen.getByText(ta.manualRefundConfirm));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledWith({ method: 'bank_transfer', reference: 'TRX-9' });
  });

  it('shows the API refusal inline and stays open', async () => {
    const onClose = vi.fn();
    render(
      <ManualRefundDialog
        open
        onConfirm={async () => 'Record the refund first'}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText(ta.manualRefundConfirm));
    expect(await screen.findByText('Record the refund first')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('every method has an English and an Arabic label', () => {
    for (const loc of ['en', 'ar'] as const) {
      for (const m of ['cash', 'instapay', 'bank_transfer', 'store_credit', 'other']) {
        expect(MESSAGES[loc].detail.actions.manualRefundMethods[m]).toBeTruthy();
      }
    }
  });
});
