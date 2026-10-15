// @vitest-environment jsdom
/** Policy updates (Ruling LEGAL-4): in-page confirmation, one POST, 409 explained. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
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
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

import PolicyUpdatesPage from './page';

const row = (docKey: string, material: boolean, send: unknown = null) => ({
  docKey,
  title: { ar: `عنوان ${docKey}`, en: docKey },
  current: {
    version: material ? '1.1' : '1.0',
    publishedAt: '2026-10-20',
    effectiveAt: '2026-11-20',
    material,
    feeChange: material,
    summary: { ar: 'ملخص', en: 'summary' },
  },
  send,
  deliveries: { queued: 0, sending: 0, sent: 0, failed: 0 },
  acceptedCount: 1234,
  canSend: material && !send,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('policy updates page', () => {
  it('asks for confirmation in the page before sending, then posts once', async () => {
    apiGet.mockResolvedValue({
      data: { policies: [row('terms', true), row('privacy', false)] },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { send: {} }, error: null });
    const confirm = vi.spyOn(window, 'confirm');
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText('confirmBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/legal-policies/terms/1.1/send-notice', {});
    expect(await screen.findByText('sendStarted')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    // only the material, unsent version offers the button
    expect(screen.queryAllByRole('button', { name: 'sendNotice' })).toHaveLength(1);
  });

  it('cancel closes the confirmation without posting', async () => {
    apiGet.mockResolvedValue({ data: { policies: [row('terms', true)] }, error: null });
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByText('confirmBody')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('explains a 409 and shows Latin-digit counts', async () => {
    apiGet.mockResolvedValue({ data: { policies: [row('terms', true)] }, error: null });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 409, code: 'ALREADY_SENT', message: 'x' },
    });
    render(<PolicyUpdatesPage />);
    expect((await screen.findByText(/accepted:/)).textContent).toContain('"n":"1234"');
    fireEvent.click(screen.getByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    expect(await screen.findByText('alreadySent')).toBeTruthy();
  });

  it('a failed load says so instead of an empty table', async () => {
    apiGet.mockResolvedValue({ data: null, error: { status: 500, code: 'X', message: 'x' } });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
  });

  it('lists failed deliveries (masked) and labels a stuck row honestly, never "in progress"', async () => {
    apiGet.mockResolvedValue({
      data: {
        policies: [
          {
            ...row('terms', true, {
              sentAt: '2026-10-21T10:00:00.000Z',
              sentBy: 'u',
              recipientCount: 5,
            }),
            deliveries: { queued: 0, sending: 2, sent: 1, failed: 2 },
            failedDeliveries: [
              {
                maskedEmail: 'a***@example.com',
                error: 'SEND_JOB_FAILED',
                at: '2026-10-21T10:05:00.000Z',
              },
              { maskedEmail: 'b***@example.com', error: null, at: '2026-10-21T10:06:00.000Z' },
            ],
          },
        ],
      },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('failedTitle')).toBeTruthy();
    expect(screen.getByText(/a\*\*\*@example\.com/).textContent).toContain('SEND_JOB_FAILED');
    expect(screen.getByText(/a\*\*\*@example\.com/).textContent).toContain('2026-10-21 10:05 UTC');
    expect((await screen.findByText(/^stuck:/)).textContent).toContain('"n":"2"');
    expect(screen.getByText(/deliveries:/).textContent).not.toContain('sending');
  });
});
