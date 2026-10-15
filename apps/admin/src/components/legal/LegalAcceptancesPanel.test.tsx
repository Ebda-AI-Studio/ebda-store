// @vitest-environment jsdom
/**
 * Acceptance records UI (final review I6, "every data has a UI"): super admin on the user page,
 * merchant in account settings. Rows render; Latin digits; masked IP only for the super admin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet, locale } = vi.hoisted(() => ({ apiGet: vi.fn(), locale: { value: 'ar' } }));
vi.mock('../../lib/api', () => ({ apiGet }));
vi.mock('next-intl', () => ({ useLocale: () => locale.value }));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { LegalAcceptancesPanel } from './LegalAcceptancesPanel';

const acceptances = [
  {
    docKey: 'terms',
    version: '1.1',
    source: 'notice_ack',
    acceptedAt: '2026-11-02T09:15:00.000Z',
    maskedIp: '203.0.113.*',
  },
  {
    docKey: 'privacy',
    version: '1.0',
    source: 'signup',
    acceptedAt: '2026-10-08T18:40:00.000Z',
    maskedIp: null,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  locale.value = 'ar';
});

describe('LegalAcceptancesPanel', () => {
  it('super admin: rows with title, version, source, UTC time, masked IP, and the notice emails', async () => {
    apiGet.mockResolvedValue({
      data: {
        acceptances,
        deliveries: [
          {
            docKey: 'terms',
            version: '1.1',
            status: 'sent',
            error: null,
            at: '2026-11-01T08:00:00.000Z',
          },
        ],
      },
      error: null,
    });
    render(<LegalAcceptancesPanel userId="u-1" />);
    expect(await screen.findByText('شروط الخدمة')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/v1/admin/users/u-1/legal-acceptances');
    expect(screen.getByText('adminTitle')).toBeTruthy();
    expect(screen.getByText('سياسة الخصوصية')).toBeTruthy();
    expect(screen.getByText('source.notice_ack')).toBeTruthy();
    expect(screen.getByText('source.signup')).toBeTruthy();
    expect(
      screen.getByText('at:{"time":"\u20662026\u2060-\u206011\u2060-\u206002\u00a009:15\u2069"}', {
        normalizer: x => x,
      })
    ).toBeTruthy();
    expect(screen.getByText('ip:{"ip":"\u2066203.0.113.*\u2069"}')).toBeTruthy();
    expect(screen.getByText('deliveriesTitle')).toBeTruthy();
    expect(screen.getByText('status.sent')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[٠-٩]/);
  });

  it('merchant: own list from /me, no IP, English titles in en', async () => {
    locale.value = 'en';
    apiGet.mockResolvedValue({ data: { acceptances }, error: null });
    render(<LegalAcceptancesPanel />);
    expect(await screen.findByText('Terms of service')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/v1/me/legal-acceptances');
    expect(screen.getByText('mineTitle')).toBeTruthy();
    expect(screen.queryByText(/^ip:/)).toBeNull();
  });

  it('empty and failed loads are distinct', async () => {
    apiGet.mockResolvedValueOnce({ data: { acceptances: [] }, error: null });
    render(<LegalAcceptancesPanel />);
    expect(await screen.findByText('empty')).toBeTruthy();
    cleanup();
    apiGet.mockResolvedValueOnce({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<LegalAcceptancesPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('loadFailed');
  });
});
