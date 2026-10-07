// @vitest-environment jsdom
/** Super-admin VAT queue: rows render, approve/reject post the right decision body. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('../../lib/open-document', () => ({ openProtectedDocument: vi.fn() }));
vi.mock('../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../components/RequireSuperAdmin', () => ({
  RequireSuperAdmin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});
vi.mock('@force/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import TaxVerificationPage from './page';

const row = {
  storeId: 'st1',
  storeName: 'Acme Store',
  storeSlug: 'acme',
  status: 'pending',
  taxRegistrationNumber: '123456789',
  legalName: 'Acme LLC',
  submittedAt: '2026-10-01T00:00:00Z',
  reviewedAt: null,
  verifiedAt: null,
  rejectionReason: null,
  documentCount: 2,
  duplicateTrnStores: 1,
};

function mockApi() {
  apiGet.mockImplementation(async (url: string) =>
    url.includes('/st1')
      ? {
          data: {
            profile: {
              status: 'pending',
              taxRegistrationNumber: '123456789',
              legalName: 'Acme LLC',
              rejectionReason: null,
              documents: [
                {
                  id: 'd1',
                  kind: 'tax_card',
                  fileName: 'card.pdf',
                  mimeType: 'application/pdf',
                  sizeBytes: 1,
                },
              ],
            },
          },
          error: null,
        }
      : { data: { profiles: [row] }, error: null }
  );
  apiPost.mockResolvedValue({ data: {}, error: null });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('super-admin tax verification page', () => {
  it('requests pending by default and renders the row with a duplicate warning', async () => {
    mockApi();
    render(<TaxVerificationPage />);
    await screen.findByText('Acme Store');
    expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/tax-verification?status=pending');
    expect(screen.getByText('123456789', { exact: false })).toBeTruthy();
    expect(screen.getByText('duplicate:{"count":1}')).toBeTruthy();
  });

  it('approves with a bare decision body', async () => {
    mockApi();
    render(<TaxVerificationPage />);
    fireEvent.click(await screen.findByText('review'));
    fireEvent.click(await screen.findByText('actions.approve'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/tax-verification/st1/decision', {
        decision: 'approve',
      })
    );
  });

  it('rejects only with a reason', async () => {
    mockApi();
    render(<TaxVerificationPage />);
    fireEvent.click(await screen.findByText('review'));
    fireEvent.click(await screen.findByText('actions.reject'));
    fireEvent.click(screen.getByText('actions.confirmReject'));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText('detail.reasonRequired')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('detail.reasonLabel'), {
      target: { value: 'blurry scan' },
    });
    fireEvent.click(screen.getByText('actions.confirmReject'));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/tax-verification/st1/decision', {
        decision: 'reject',
        reason: 'blurry scan',
      })
    );
  });

  it('shows an error state when the list fails to load', async () => {
    apiGet.mockResolvedValue({ data: null, error: { code: 'X', message: 'boom', status: 500 } });
    render(<TaxVerificationPage />);
    expect((await screen.findByRole('alert')).textContent).toBe('loadFailed');
  });
});
