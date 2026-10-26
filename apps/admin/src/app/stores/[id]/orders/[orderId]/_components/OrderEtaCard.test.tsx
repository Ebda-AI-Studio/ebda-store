// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../../../../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { OrderEtaCard } from './OrderEtaCard';

const row = (o = {}) => ({
  id: 'r1',
  kind: 'sale',
  seq: 1,
  status: 'queued',
  receiptNumber: 'EB-1',
  longId: null,
  errorCode: null,
  errorMessage: null,
  qr: null,
  qrSvg: null,
  ...o,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrderEtaCard', () => {
  it('renders nothing when no receipt exists', async () => {
    apiGet.mockResolvedValue({ data: { receipts: [] } });
    const { container } = render(<OrderEtaCard storeId="s" orderId="o" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
  it('shows the QR only for accepted and offers re-issue only for failed/rejected', async () => {
    apiGet.mockResolvedValue({
      data: {
        receipts: [
          row({
            status: 'accepted',
            qr: 'https://x/receipts/search/u/share/t#Total:1,IssuerRIN:2',
            qrSvg: '<svg/>',
          }),
        ],
      },
    });
    const { container } = render(<OrderEtaCard storeId="s" orderId="o" />);
    await screen.findByText('status.accepted');
    expect(container.querySelector('img')).toBeTruthy();
    expect(screen.queryByText('issueAgain')).toBeNull();
  });
  it('re-issue posts to the retry route', async () => {
    apiGet.mockResolvedValue({
      data: { receipts: [row({ status: 'rejected', errorCode: 'CV307' })] },
    });
    apiPost.mockResolvedValue({ data: { queued: true } });
    render(<OrderEtaCard storeId="s" orderId="o" />);
    await screen.findByText(/CV307/);
    fireEvent.click(screen.getByText('issueAgain'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s/eta/receipts/r1/retry', {})
    );
  });
  it('price-only refund: the reason picker is required before the receipt is issued', async () => {
    apiGet.mockResolvedValue({
      data: { receipts: [row({ kind: 'return', status: 'manual', errorCode: 'reason_required' })] },
    });
    apiPost.mockResolvedValue({ data: { queued: true } });
    render(<OrderEtaCard storeId="s" orderId="o" />);
    const submit = (await screen.findByText('reasonSubmit')) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('International return receipt')).toBeTruthy();
    expect(screen.getByText('Sales issued before adoption')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('reasonLabel'), { target: { value: 'B' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s/eta/receipts/r1/return-reason', {
        reason: 'B',
      })
    );
  });

  it('shows no picker for other manual or non-return rows', async () => {
    apiGet.mockResolvedValue({ data: { receipts: [row({ status: 'queued' })] } });
    render(<OrderEtaCard storeId="s" orderId="o" />);
    await screen.findByText('status.queued');
    expect(screen.queryByText('reasonSubmit')).toBeNull();
  });
});
