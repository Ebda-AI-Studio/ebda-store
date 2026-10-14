// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstapayReceiptView } from '@ebda/shared';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../lib/api', () => ({ apiFetch }));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { InstapayReceiptReview } from './InstapayReceiptReview';

function receipt(over: Partial<InstapayReceiptView> = {}): InstapayReceiptView {
  return {
    id: 'r1',
    kind: 'order',
    status: 'submitted',
    extractionStatus: 'done',
    extracted: {
      amountMinor: 12000,
      reference: '123456789012',
      transferDate: '2026-10-05',
      transferTime: '14:35',
      payerName: 'Ahmed M***',
      payerAddress: null,
      payerMobile: null,
      payerBank: 'CIB',
      receiverName: null,
      receiverHandle: null,
      receiverMobile: null,
      note: null,
      direction: 'sent',
      looksEdited: false,
      confidence: 0.91,
    },
    confidence: 0.91,
    fields: {
      amountMinor: 10000,
      reference: '123456789012',
      transferredAt: '2026-10-05T11:35:00.000Z',
      payerName: 'Ahmed M***',
      payerAddress: null,
      payerMobile: null,
      payerBank: 'CIB',
      receiverName: null,
      receiverHandle: null,
      receiverMobile: null,
      note: null,
    },
    expectedAmountMinor: 12000,
    expectedReceiver: 'shop@instapay',
    flags: ['AMOUNT_MISMATCH', 'FIELDS_CORRECTED'],
    reviewNote: null,
    submittedAt: '2026-10-05T11:36:00.000Z',
    reviewedAt: null,
    createdAt: '2026-10-05T11:30:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
  URL.createObjectURL = vi.fn(() => 'blob:receipt');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InstapayReceiptReview', () => {
  it('loads the screenshot through the authenticated fetch as a blob URL, never a public URL', async () => {
    render(<InstapayReceiptReview receipt={receipt()} imageEndpoint="/img/1" />);
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toBe('blob:receipt');
    expect(apiFetch).toHaveBeenCalledWith('/img/1');
  });

  it('shows flags as warnings, the mismatch prominently, and submitted vs read values (Cairo time)', async () => {
    render(<InstapayReceiptReview receipt={receipt()} imageEndpoint="/img/1" />);
    expect(screen.getByText('AMOUNT_MISMATCH')).toBeTruthy();
    expect(screen.getByText('FIELDS_CORRECTED')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('amountMismatch');
    expect(screen.getByText('confidence:{"pct":91}')).toBeTruthy();
    // 11:35 UTC is 14:35 in Cairo (UTC+3 in October 2026): equals the AI's read.
    expect(screen.getAllByText('2026-10-05 14:35').length).toBe(2);
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
  });

  it('offers approve and reject only when handlers are given and the receipt is submitted', () => {
    const { rerender } = render(<InstapayReceiptReview receipt={receipt()} imageEndpoint="/i" />);
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
    rerender(
      <InstapayReceiptReview
        receipt={receipt()}
        imageEndpoint="/i"
        onApprove={() => {}}
        onReject={async () => null}
      />
    );
    expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'reject' })).toBeTruthy();
    rerender(
      <InstapayReceiptReview
        receipt={receipt({ status: 'approved' })}
        imageEndpoint="/i"
        onApprove={() => {}}
        onReject={async () => null}
      />
    );
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
  });

  it('reject needs a reason of at least 3 characters, then sends it', async () => {
    const onReject = vi.fn(async () => null);
    render(
      <InstapayReceiptReview
        receipt={receipt()}
        imageEndpoint="/i"
        onApprove={() => {}}
        onReject={onReject}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'reject' }));
    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: 'no' } });
    fireEvent.click(screen.getByRole('button', { name: 'rejectSubmit' }));
    expect(await screen.findByText('reasonRequired')).toBeTruthy();
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: 'Wrong amount' } });
    fireEvent.click(screen.getByRole('button', { name: 'rejectSubmit' }));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith('Wrong amount'));
  });
});
