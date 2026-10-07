// @vitest-environment jsdom
/**
 * VAT registration card (ruling TAX-2): each status renders its own banner, and
 * the details/documents/submit controls are editable only in none/rejected/revoked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ apiGet, apiPut, apiPost, apiDelete: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/open-document', () => ({ openProtectedDocument: vi.fn() }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key}:${JSON.stringify(vals)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { TaxVerificationCard, type TaxProfile } from './TaxVerificationCard';

const profile = (over: Partial<TaxProfile> = {}): TaxProfile => ({
  status: 'none',
  taxRegistrationNumber: null,
  legalName: null,
  attestedAt: null,
  submittedAt: null,
  reviewedAt: null,
  verifiedAt: null,
  revokedAt: null,
  rejectionReason: null,
  documents: [],
  ...over,
});

const doc = {
  id: 'd1',
  kind: 'tax_card' as const,
  fileName: 'card.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  createdAt: '2026-10-01T00:00:00Z',
};

async function renderWith(p: TaxProfile) {
  apiGet.mockResolvedValue({ data: { profile: p }, error: null });
  const onStatusChange = vi.fn();
  const view = render(<TaxVerificationCard storeId="s1" onStatusChange={onStatusChange} />);
  await waitFor(() => expect(screen.getByTestId('vat-status-banner')).toBeTruthy());
  return { ...view, onStatusChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaxVerificationCard', () => {
  it('none: editable form, submit disabled until attested', async () => {
    const { onStatusChange } = await renderWith(profile());
    expect(onStatusChange).toHaveBeenCalledWith('none');
    expect(screen.getByTestId('vat-status-banner').getAttribute('data-status')).toBe('none');
    const trn = screen.getByPlaceholderText('form.trnPlaceholder') as HTMLInputElement;
    expect(trn.disabled).toBe(false);
    const submit = screen.getByText('submit.button') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
  });

  it('rejected: shows the reason and stays editable', async () => {
    await renderWith(profile({ status: 'rejected', rejectionReason: 'blurry scan' }));
    expect(screen.getByTestId('vat-status-banner').textContent).toContain('blurry scan');
    expect((screen.getByPlaceholderText('form.trnPlaceholder') as HTMLInputElement).disabled).toBe(
      false
    );
  });

  it('revoked: shows the reason and stays editable', async () => {
    await renderWith(profile({ status: 'revoked', rejectionReason: 'wrong number' }));
    expect(screen.getByTestId('vat-status-banner').textContent).toContain('wrong number');
    expect(screen.getByText('submit.button')).toBeTruthy();
  });

  it.each(['pending', 'verified'] as const)(
    '%s: details locked, no upload/delete/submit',
    async status => {
      await renderWith(
        profile({
          status,
          taxRegistrationNumber: '123456789',
          legalName: 'Acme',
          verifiedAt: '2026-10-02T00:00:00Z',
          documents: [doc],
        })
      );
      expect(
        (screen.getByPlaceholderText('form.trnPlaceholder') as HTMLInputElement).disabled
      ).toBe(true);
      expect(screen.queryByText('submit.button')).toBeNull();
      expect(screen.queryByText('documents.upload')).toBeNull();
      expect(screen.queryByText('documents.delete')).toBeNull();
      expect(screen.getByText('documents.view')).toBeTruthy();
      expect(screen.getByTestId('vat-status-banner').getAttribute('data-status')).toBe(status);
    }
  );

  it('verified: points changes to support', async () => {
    await renderWith(profile({ status: 'verified', verifiedAt: '2026-10-02T00:00:00Z' }));
    expect(screen.getByText('verifiedNote')).toBeTruthy();
  });

  it('rejects an invalid TRN client-side without calling the API', async () => {
    await renderWith(profile());
    fireEvent.change(screen.getByPlaceholderText('form.trnPlaceholder'), {
      target: { value: '12-34' },
    });
    fireEvent.click(screen.getByText('form.save'));
    expect(screen.getByRole('alert').textContent).toBe('form.trnInvalid');
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('submits with attest:true once attested', async () => {
    await renderWith(profile());
    apiPost.mockResolvedValue({ data: { profile: profile({ status: 'pending' }) }, error: null });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('submit.button'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/stores/s1/tax/profile/submit', { attest: true })
    );
    await waitFor(() =>
      expect(screen.getByTestId('vat-status-banner').getAttribute('data-status')).toBe('pending')
    );
  });
});
