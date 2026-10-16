// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

const lang = { language: 'en' as 'en' | 'ar' };
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang.language,
    isRtl: lang.language === 'ar',
    t: (en: string, ar: string) => (lang.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { timezone: 'Africa/Cairo', theme: {} } }),
}));
vi.mock('../../../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n / 100}`,
}));
vi.mock('@/lib/format-date', () => ({ formatDate: () => 'soon' }));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postForm: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));

import { InstapayCard } from './InstapayCard';

const instructions = {
  amountMinor: 25000,
  handle: 'shop@instapay',
  reference: 'ORD-1',
  expiresAt: '2026-10-09T00:00:00Z',
};
const orderView = (proof: unknown = null) => ({
  success: true,
  data: {
    orderStatus: 'awaiting_payment_confirmation',
    paymentStatus: 'unpaid',
    instructions,
    proof,
  },
});
const receipt = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  kind: 'order',
  status: 'draft',
  extractionStatus: 'done',
  extracted: {
    amountMinor: 25000,
    reference: '123456789012',
    transferDate: '2026-10-08',
    transferTime: '14:05',
    payerName: 'Ahmed M***',
    payerAddress: 'ahmed@instapay',
    payerMobile: null,
    payerBank: 'CIB',
    receiverName: null,
    receiverHandle: 'shop@instapay',
    receiverMobile: null,
    note: null,
    direction: 'sent',
    looksEdited: false,
    confidence: 0.9,
  },
  ...over,
});

beforeEach(() => {
  lang.language = 'en';
  Object.values(api).forEach(m => m.mockReset());
});
afterEach(cleanup);

function pickFile(file: File) {
  const input = document.getElementById('instapay-receipt-file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}
const png = () => new File([new Uint8Array(10)], 'r.png', { type: 'image/png' });

describe('InstapayCard receipt flow', () => {
  it('has no typed reference box', async () => {
    api.get.mockResolvedValue(orderView());
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-card');
    expect(document.getElementById('instapay-ref')).toBeNull();
    expect(screen.queryByText(/Transfer reference \(optional\)/)).toBeNull();
    expect(document.getElementById('instapay-receipt-file')).not.toBeNull();
  });

  it('upload -> prefilled form -> submit posts the corrected fields, then shows the owner-review copy', async () => {
    api.get.mockResolvedValue(orderView());
    api.postForm.mockResolvedValue({ success: true, data: { receipt: receipt() } });
    api.post.mockResolvedValue({
      success: true,
      data: { receipt: receipt({ status: 'submitted' }) },
    });
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-card');
    pickFile(png());
    await screen.findByTestId('instapay-receipt-form');
    expect(api.postForm.mock.calls[0][0]).toBe('/payments/instapay/o1/receipt');
    expect((api.postForm.mock.calls[0][1] as FormData).get('file')).toBeInstanceOf(File);
    expect((screen.getByLabelText('Amount (EGP)') as HTMLInputElement).value).toBe('250.00');
    expect((screen.getByLabelText('Transfer reference') as HTMLInputElement).value).toBe(
      '123456789012'
    );
    fireEvent.change(screen.getByLabelText('Sender bank'), { target: { value: 'NBE' } });
    fireEvent.click(screen.getByText('Send receipt'));
    await screen.findByTestId('instapay-review-notice');
    expect(api.post).toHaveBeenCalledWith(
      '/payments/instapay/o1/receipt/r1/submit',
      expect.objectContaining({
        amountMinor: 25000,
        reference: '123456789012',
        transferDate: '2026-10-08',
        transferTime: '14:05',
        payerName: 'Ahmed M***',
        payerBank: 'NBE',
        payerMobile: null,
      })
    );
    expect(screen.getByText('The store owner will review your transfer.')).toBeTruthy();
  });

  it('shows the Arabic owner-review copy when a proof is already submitted', async () => {
    lang.language = 'ar';
    api.get.mockResolvedValue(
      orderView({
        receiptId: 'r1',
        status: 'submitted',
        reviewNote: null,
        submittedAt: 'x',
        reviewedAt: null,
      })
    );
    render(<InstapayCard orderId="o1" />);
    await screen.findByText('سيراجع صاحب المتجر التحويل');
    expect(document.getElementById('instapay-receipt-file')).toBeNull();
  });

  it('rejected proof shows the reason and allows uploading again', async () => {
    api.get.mockResolvedValue(
      orderView({
        receiptId: 'r1',
        status: 'rejected',
        reviewNote: 'Wrong amount',
        submittedAt: 'x',
        reviewedAt: 'y',
      })
    );
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-proof-rejected');
    expect(screen.getByText(/Wrong amount/)).toBeTruthy();
    expect(document.getElementById('instapay-receipt-file')).not.toBeNull();
  });

  it('failed extraction shows the empty form with the manual-entry notice', async () => {
    api.get.mockResolvedValue(orderView());
    api.postForm.mockResolvedValue({
      success: true,
      data: { receipt: receipt({ extractionStatus: 'failed', extracted: null }) },
    });
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-card');
    pickFile(png());
    await screen.findByText(/We could not read it automatically/);
    expect((screen.getByLabelText('Amount (EGP)') as HTMLInputElement).value).toBe('');
  });

  it('maps DUPLICATE_REFERENCE on submit to a friendly message', async () => {
    api.get.mockResolvedValue(orderView());
    api.postForm.mockResolvedValue({ success: true, data: { receipt: receipt() } });
    api.post.mockResolvedValue({ success: false, error: { code: 'DUPLICATE_REFERENCE' } });
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-card');
    pickFile(png());
    await screen.findByTestId('instapay-receipt-form');
    fireEvent.click(screen.getByText('Send receipt'));
    await waitFor(() =>
      expect(screen.getByTestId('instapay-error').textContent).toMatch(/already used/)
    );
    expect(screen.queryByTestId('instapay-review-notice')).toBeNull();
  });

  it('rejects a wrong file type or oversize file client-side without uploading', async () => {
    api.get.mockResolvedValue(orderView());
    render(<InstapayCard orderId="o1" />);
    await screen.findByTestId('instapay-card');
    pickFile(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    await screen.findByText('Please upload a JPG, PNG or WebP image.');
    const big = new File([new Uint8Array(1)], 'b.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    pickFile(big);
    await screen.findByText('The image is larger than 8 MB.');
    expect(api.postForm).not.toHaveBeenCalled();
  });
});
