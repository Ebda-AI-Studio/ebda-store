// @vitest-environment jsdom
/**
 * Policy-change banner (Ruling LEGAL-4): one banner for every pending notice, Latin digits,
 * one "Got it" acknowledges all of them, never blocks the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost, locale } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  locale: { value: 'ar' },
}));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => locale.value }));
vi.mock('../../i18n/useT', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { useT: () => t };
});

import { LegalNoticeBanner } from './LegalNoticeBanner';

const notice = (docKey: string, ar: string) => ({
  docKey,
  version: '1.1',
  effectiveAt: '2026-11-20',
  summary: { ar, en: `${docKey} changed` },
  title: { ar: `عنوان ${docKey}`, en: docKey },
  url: { ar: `https://ebda.app/${docKey}/`, en: `https://ebda.app/en/${docKey}/` },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  locale.value = 'ar';
});

describe('LegalNoticeBanner', () => {
  it('renders nothing when nothing is pending', async () => {
    apiGet.mockResolvedValue({ data: { notices: [] }, error: null });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/v1/me/legal-notices'));
    expect(container.textContent).toBe('');
  });

  it('renders nothing and no error while impersonating (GET 403)', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { status: 403, code: 'FORBIDDEN', message: 'x' },
    });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists every pending notice in ONE banner, in Arabic, with Latin digits and policy links', async () => {
    apiGet.mockResolvedValue({
      data: { notices: [notice('terms', 'تغيير في الرسوم.'), notice('privacy', 'مزوّد جديد.')] },
      error: null,
    });
    render(<LegalNoticeBanner storeId="s1" />);
    const banner = await screen.findByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(banner.textContent).toContain('تغيير في الرسوم.');
    expect(banner.textContent).toContain('مزوّد جديد.');
    expect(banner.textContent).toContain('20 نوفمبر 2026');
    expect(banner.textContent).not.toMatch(/[٠-٩]/);
    expect(screen.getAllByRole('link').map(a => a.getAttribute('href'))).toEqual([
      'https://ebda.app/terms/',
      'https://ebda.app/privacy/',
    ]);
  });

  it('renders the English copy, date and links in en', async () => {
    locale.value = 'en';
    apiGet.mockResolvedValue({ data: { notices: [notice('terms', 'أ')] }, error: null });
    render(<LegalNoticeBanner storeId="s1" />);
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('terms changed');
    expect(banner.textContent).toContain('20 November 2026');
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://ebda.app/en/terms/');
  });

  it('one "Got it" acknowledges all shown notices, once, then hides and keeps focus on the page', async () => {
    const main = document.createElement('main');
    main.id = 'admin-main-content';
    main.tabIndex = -1;
    document.body.appendChild(main);
    apiGet.mockResolvedValue({
      data: { notices: [notice('terms', 'أ'), notice('privacy', 'ب')] },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { acknowledged: 2 }, error: null });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/v1/me/legal-notices/ack', {
      items: [
        { docKey: 'terms', version: '1.1' },
        { docKey: 'privacy', version: '1.1' },
      ],
    });
    expect(document.activeElement).toBe(main);
    main.remove();
  });

  it('a failed ack keeps the banner and says so', async () => {
    apiGet.mockResolvedValue({ data: { notices: [notice('terms', 'أ')] }, error: null });
    apiPost.mockResolvedValue({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ackFailed');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('422 NOT_PENDING re-reads the list, shows the fresh notice and the inline error', async () => {
    const v2 = { ...notice('terms', 'جديد'), version: '1.2' };
    apiGet
      .mockResolvedValueOnce({ data: { notices: [notice('terms', 'قديم')] }, error: null })
      .mockResolvedValueOnce({ data: { notices: [v2] }, error: null });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 422, code: 'NOT_PENDING', message: 'x' },
    });
    render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ackFailed');
    expect(apiGet).toHaveBeenCalledTimes(2);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('جديد');
    expect(banner.textContent).not.toContain('قديم');
  });

  it('422 with nothing pending any more (acked elsewhere) just removes the banner', async () => {
    apiGet
      .mockResolvedValueOnce({ data: { notices: [notice('terms', 'أ')] }, error: null })
      .mockResolvedValueOnce({ data: { notices: [] }, error: null });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 422, code: 'NOT_PENDING', message: 'x' },
    });
    const { container } = render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('re-reads when the store changes (a notice acked in another store is gone there too)', async () => {
    apiGet.mockResolvedValue({ data: { notices: [] }, error: null });
    const { rerender } = render(<LegalNoticeBanner storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender(<LegalNoticeBanner storeId="s2" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it('ack fails AND the re-read fails: the banner stays with the inline error (M13)', async () => {
    apiGet
      .mockResolvedValueOnce({ data: { notices: [notice('terms', 'أ')] }, error: null })
      .mockResolvedValueOnce({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    apiPost.mockResolvedValue({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<LegalNoticeBanner storeId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'gotIt' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ackFailed');
    expect(screen.getByRole('status').textContent).toContain('أ');
    expect(screen.getByRole('button', { name: 'gotIt' })).not.toHaveProperty('disabled', true);
  });

  it('a double click posts once: the button is disabled while saving (M13)', async () => {
    apiGet.mockResolvedValue({ data: { notices: [notice('terms', 'أ')] }, error: null });
    let release: (v: unknown) => void = () => undefined;
    apiPost.mockReturnValue(new Promise(r => (release = r)));
    render(<LegalNoticeBanner storeId="s1" />);
    const btn = await screen.findByRole('button', { name: 'gotIt' });
    fireEvent.click(btn);
    const saving = await screen.findByRole('button', { name: 'saving' });
    expect(saving).toHaveProperty('disabled', true);
    fireEvent.click(saving);
    expect(apiPost).toHaveBeenCalledTimes(1);
    release({ data: { acknowledged: 1 }, error: null });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('each "Read the policy" link is named after its document (M11)', async () => {
    apiGet.mockResolvedValue({
      data: { notices: [notice('terms', 'أ'), notice('privacy', 'ب')] },
      error: null,
    });
    render(<LegalNoticeBanner storeId="s1" />);
    await screen.findByRole('status');
    expect(screen.getAllByRole('link').map(a => a.getAttribute('aria-label'))).toEqual([
      'readAria:{"title":"عنوان terms"}',
      'readAria:{"title":"عنوان privacy"}',
    ]);
  });
});

describe('store layout mounts the banner (M13)', () => {
  it('renders LegalNoticeBanner for the store in the URL, next to the billing banner', async () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useParams: () => ({ id: 'store-9' }),
      usePathname: () => '/stores/store-9/orders',
    }));
    vi.doMock('../PlanGate', () => ({
      PlanGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    }));
    vi.doMock('../../hooks/useFeatures', () => ({
      AdminFeatureProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    }));
    vi.doMock('../../contexts/NotificationContext', () => ({
      useNotifications: () => ({ subscribeToStore: vi.fn(), unsubscribeFromStore: vi.fn() }),
    }));
    vi.doMock('../billing/BillingStatusBanner', () => ({
      BillingStatusBanner: ({ storeId }: { storeId: string }) => <div>billing:{storeId}</div>,
    }));
    apiGet.mockResolvedValue({ data: { notices: [notice('terms', 'أ')] }, error: null });
    const { default: StoreLayout } = await import('../../app/stores/[id]/layout');
    render(
      <StoreLayout>
        <p>page</p>
      </StoreLayout>
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('billing:store-9')).toBeTruthy();
    expect(screen.getByText('page')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/api/v1/me/legal-notices');
  });
});
