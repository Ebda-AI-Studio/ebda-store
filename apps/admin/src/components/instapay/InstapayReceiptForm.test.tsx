// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiFetch, apiGet, apiPost } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ apiFetch, apiGet, apiPost }));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@force/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: ({
    label,
    error,
    ...p
  }: { label?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={p.id}>{label}</label>
      <input {...p} />
      {error && <p>{error}</p>}
    </div>
  ),
}));

import { InstapayReceiptForm } from './InstapayReceiptForm';

const done = {
  id: 'r1',
  extractionStatus: 'done',
  extracted: {
    amountMinor: 349000,
    reference: '123456789012',
    transferDate: '2026-10-05',
    transferTime: '14:35',
    payerName: 'Ahmed M***',
    payerBank: 'CIB',
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function upload() {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { receipt: done } }) });
  const file = new File(['x'], 'r.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('file'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'upload' }));
}

describe('InstapayReceiptForm', () => {
  it('says who reviews, uploads, prefills from the AI read and submits piastres', async () => {
    apiPost.mockResolvedValue({ data: { claim: { id: 'c1' } }, error: null });
    const onSubmitted = vi.fn();
    render(
      <InstapayReceiptForm
        baseUrl="/api/v1/stores/s1/billing/receipts"
        reviewerNote="The Ebda team will review your transfer."
        onSubmitted={onSubmitted}
      />
    );
    expect(screen.getByTestId('receipt-reviewer-note').textContent).toBe(
      'The Ebda team will review your transfer.'
    );
    await upload();
    expect(((await screen.findByLabelText('amount')) as HTMLInputElement).value).toBe('3490.00');
    expect((screen.getByLabelText('payerName') as HTMLInputElement).value).toBe('Ahmed M***');
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/stores/s1/billing/receipts');
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/stores/s1/billing/receipts/r1/submit',
      expect.objectContaining({
        amountMinor: 349000,
        reference: '123456789012',
        transferDate: '2026-10-05',
        transferTime: '14:35',
        payerName: 'Ahmed M***',
        payerBank: 'CIB',
        payerAddress: null,
      })
    );
  });

  it('validates the reference and shows the duplicate-reference error from the API', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'DUPLICATE_REFERENCE', message: 'x', status: 409 },
    });
    render(<InstapayReceiptForm baseUrl="/b" reviewerNote="n" onSubmitted={() => {}} />);
    await upload();
    fireEvent.change(await screen.findByLabelText('reference'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(await screen.findByText('referenceInvalid')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('reference'), { target: { value: '999999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('DUPLICATE_REFERENCE');
  });

  it('a failed read falls back to empty manual entry', async () => {
    render(<InstapayReceiptForm baseUrl="/b" reviewerNote="n" onSubmitted={() => {}} />);
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { receipt: { id: 'r2', extractionStatus: 'failed', extracted: null } },
      }),
    });
    fireEvent.change(screen.getByLabelText('file'), {
      target: { files: [new File(['x'], 'r.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'upload' }));
    expect(await screen.findByText('readFailed')).toBeTruthy();
    expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('');
  });
});
