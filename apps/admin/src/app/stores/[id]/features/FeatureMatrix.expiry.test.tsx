// @vitest-environment jsdom
/**
 * Ruling SF-EXPIRY-1 (#843): the super-admin FeatureMatrix shows an override's expiry, treats an expired one as
 * "no override" (plan default), and saves a new expiry + reason with the whole override.
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
const h = vi.hoisted(() => ({ override: {} as Record<string, unknown> }));

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
        ? { data: { features: {}, metadata: [h.override], registry: {} }, error: null }
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

const override = (expiresAt: string | null) => ({
  featureKey: 'whatsapp',
  enabled: true,
  enabledAt: null,
  enabledBy: null,
  expiresAt,
  reason: 'comp',
  updatedAt: '2026-11-01T00:00:00.000Z',
});
const renderMatrix = () =>
  render(
    <ToastProvider>
      <FeatureMatrix storeId="s1" />
    </ToastProvider>
  );
const whatsappRow = async () =>
  (await screen.findByText('WhatsApp Notifications')).closest('div.flex.items-start')!;

describe('FeatureMatrix → override expiry', () => {
  it('a live override shows when it expires; an expired one reads as the plan default', async () => {
    h.override = override(new Date(Date.now() + 5 * 86_400_000).toISOString());
    renderMatrix();
    let row = await whatsappRow();
    expect(row.textContent).toContain('badges.grantedByOverride');
    expect(row.textContent).toContain('expiresOn');
    cleanup();

    h.override = override(new Date(Date.now() - 86_400_000).toISOString());
    renderMatrix();
    row = await whatsappRow();
    expect(row.textContent).not.toContain('badges.grantedByOverride');
    expect(row.textContent).toContain('expired');
  });

  it('saving the expiry PUTs the whole override with the date and reason', async () => {
    h.override = override(null);
    renderMatrix();
    const row = await whatsappRow();
    fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'edit')!
    );
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2999-12-16' } });
    fireEvent.click(await screen.findByText('save'));
    await waitFor(() => expect(api.apiPut).toHaveBeenCalledTimes(1));
    expect(String(api.apiPut.mock.calls[0][0])).toContain('/features/whatsapp');
    expect(api.apiPut.mock.calls[0][1]).toEqual({
      enabled: true,
      expiresAt: '2999-12-16T23:59:59.000Z',
      reason: 'comp',
    });
  });

  it('a past date is refused in the form and nothing is sent', async () => {
    h.override = override(null);
    renderMatrix();
    const row = await whatsappRow();
    fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'edit')!
    );
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, {
      target: { value: '2001-01-01' },
    });
    fireEvent.click(await screen.findByText('save'));
    await new Promise(r => setTimeout(r, 20));
    expect(api.apiPut).not.toHaveBeenCalled();
  });
});
