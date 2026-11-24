// @vitest-environment jsdom
/**
 * Audit 2026-09-30 §9 — a feature toggle in the super-admin FeatureMatrix
 * refreshed only the matrix's own local state; the store-wide feature
 * context (sidebar, page gates, the Settings MCP card) stayed stale until a
 * hard reload. Every successful write must now also refresh that context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
}));
const features = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true, rich: (key: string) => key });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/api', () => api);
vi.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ isEnabled: () => true, isLoading: false, refresh: features.refresh }),
}));

import { ToastProvider } from '@ebda/ui';
import { FeatureMatrix } from './FeatureMatrix';

beforeEach(() => {
  api.apiGet.mockImplementation((url: string) =>
    Promise.resolve(
      url.endsWith('/features')
        ? { data: { features: {}, metadata: [], registry: {} }, error: null }
        : {
            data: { store: { id: 's1', name: 'S', plan: 'starter', status: 'active' } },
            error: null,
          }
    )
  );
  api.apiPut.mockResolvedValue({ data: {}, error: null });
  api.apiDelete.mockResolvedValue({ data: {}, error: null });
  features.refresh.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeatureMatrix → store feature context', () => {
  it('refreshes the store-wide feature context after a successful toggle', async () => {
    render(
      <ToastProvider>
        <FeatureMatrix storeId="s1" />
      </ToastProvider>
    );
    const toggles = await screen.findAllByRole('switch');
    fireEvent.click(toggles[0]);

    await waitFor(() => expect(features.refresh).toHaveBeenCalledTimes(1));
    expect(api.apiPut.mock.calls.length + api.apiDelete.mock.calls.length).toBe(1);
  });

  it('does not refresh when the write failed', async () => {
    api.apiPut.mockResolvedValue({ data: null, error: { message: 'nope' } });
    api.apiDelete.mockResolvedValue({ data: null, error: { message: 'nope' } });
    render(
      <ToastProvider>
        <FeatureMatrix storeId="s1" />
      </ToastProvider>
    );
    const toggles = await screen.findAllByRole('switch');
    fireEvent.click(toggles[0]);

    await waitFor(() =>
      expect(api.apiPut.mock.calls.length + api.apiDelete.mock.calls.length).toBe(1)
    );
    expect(features.refresh).not.toHaveBeenCalled();
  });
});

describe('FeatureMatrix → hidden-from-merchants features (WHATSAPP-OFF-1)', () => {
  it('shows whatsapp with the badge and toggles it via PUT; platform-hidden ones stay out', async () => {
    render(
      <ToastProvider>
        <FeatureMatrix storeId="s1" />
      </ToastProvider>
    );
    expect(await screen.findByText('WhatsApp Order Updates')).toBeTruthy();
    // whatsapp (WHATSAPP-OFF-1), b2b.wholesale (hidden from merchants until its UI ships, B2B Task 8 removes the flag)
    // and eta_ereceipt (Ruling ETA-1: a super-admin switches the ETA e-receipt connector on per store).
    expect(screen.getAllByText('row.hiddenFromMerchants').length).toBe(3);
    expect(screen.getByText('ETA e-receipts (Egypt)')).toBeTruthy();
    expect(screen.getByText('Wholesale pricing')).toBeTruthy();
    expect(screen.queryByText('SEO Tools')).toBeNull();

    const row = screen.getByText('WhatsApp Order Updates').closest('div.flex.items-start');
    fireEvent.click(row!.querySelector('[role="switch"]')!);
    await waitFor(() => expect(api.apiPut).toHaveBeenCalledTimes(1));
    expect(String(api.apiPut.mock.calls[0][0])).toContain('/features/whatsapp');
  });
});
