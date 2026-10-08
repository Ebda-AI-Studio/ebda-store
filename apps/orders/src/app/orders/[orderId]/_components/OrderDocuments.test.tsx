// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MESSAGES } from '@/i18n/messages';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@/lib/api', () => api);
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: MESSAGES.en, locale: 'en' }),
}));

import { OrderDocuments } from './OrderDocuments';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('orders PWA Documents card', () => {
  it('lists the order’s documents', async () => {
    api.apiGet.mockResolvedValue({
      data: {
        documents: [
          {
            id: 'd1',
            docType: 'credit_note',
            number: 'CN-000003',
            status: 'cancelled',
            issuedAt: '2026-10-01T10:00:00.000Z',
            totalAmount: 5000,
            currency: 'EGP',
          },
        ],
      },
    });
    render(<OrderDocuments storeId="s1" orderId="o1" />);
    expect(await screen.findByText('CN-000003')).toBeTruthy();
    expect(screen.getByText(/Credit note/)).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('50.00 EGP')).toBeTruthy();
    expect(api.apiGet).toHaveBeenCalledWith('/api/v1/stores/s1/orders/o1/fiscal-documents');
  });

  it('says so when none were issued', async () => {
    api.apiGet.mockResolvedValue({ data: { documents: [] } });
    render(<OrderDocuments storeId="s1" orderId="o1" />);
    expect(await screen.findByText(MESSAGES.en.detail.documents.empty)).toBeTruthy();
  });
});
