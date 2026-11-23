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
  stuckSending: 0,
  noRun: false,
  stalled: false,
  acceptedCount: 1234,
  canSend: material && !send,
  sendBlocked: null,
});
const SENT = { sentAt: '2026-10-21T10:00:00.000Z', sentBy: 'u', recipientCount: 5 };

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

  it('lists failed deliveries (masked) and labels an AGED sending row stuck (I4)', async () => {
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
            stuckSending: 2,
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
    expect(screen.getByText(/a\*\*\*@example\.com/).textContent).toContain(
      '2026\u2060-\u206010\u2060-\u206021\u00a010:05'
    );
    expect((await screen.findByText(/^stuck:/)).textContent).toContain('"n":"2"');
    expect(screen.getByText(/deliveries:/).textContent).not.toContain('sending');
  });

  it('shows a distinct message when the withdrawal failed, and a no-run line for a send with no recipients yet', async () => {
    apiGet.mockResolvedValue({
      data: { policies: [row('terms', true)] },
      error: null,
    });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 502, code: 'WITHDRAW_FAILED', message: 'x' },
    });
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    expect(await screen.findByText('sendUncertain')).toBeTruthy();
    expect(screen.queryByText('sendFailed')).toBeNull();
  });

  it('I4: a fresh send with no recipients yet reads "starting", never the red noRun', async () => {
    apiGet.mockResolvedValue({
      data: { policies: [row('terms', true, { ...SENT, recipientCount: null })] },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('starting')).toBeTruthy();
    expect(screen.queryByText('noRun')).toBeNull();
    expect(screen.queryByRole('button', { name: 'resume' })).toBeNull();
  });

  it('I4: a sending row in flight reads neutral "sending", never "stuck"', async () => {
    apiGet.mockResolvedValue({
      data: {
        policies: [
          {
            ...row('terms', true, SENT),
            deliveries: { queued: 3, sending: 1, sent: 1, failed: 0 },
          },
        ],
      },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect((await screen.findByText(/^inProgress:/)).textContent).toContain('"n":"4"');
    expect(screen.queryByText(/^stuck:/)).toBeNull();
  });

  it('I4/I5: noRun (aged) is labelled and offers Resume, which confirms in the page and posts once', async () => {
    apiGet.mockResolvedValue({
      data: {
        policies: [
          { ...row('terms', true, { ...SENT, recipientCount: null }), noRun: true, stalled: true },
        ],
      },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { docKey: 'terms', version: '1.1' }, error: null });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('noRun')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'resume' }));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByText('resumeBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'resumeConfirm' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/legal-policies/terms/1.1/resume', {});
    expect(await screen.findByText('resumeStarted')).toBeTruthy();
  });

  it('I5: Retry failed shows the count, confirms, posts once and reports how many were requeued', async () => {
    apiGet.mockResolvedValue({
      data: {
        policies: [
          {
            ...row('terms', true, SENT),
            deliveries: { queued: 0, sending: 0, sent: 3, failed: 2 },
          },
        ],
      },
      error: null,
    });
    apiPost.mockResolvedValue({ data: { requeued: 2 }, error: null });
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'retryFailed:{"n":"2"}' }));
    expect(screen.getByText('retryBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'retryFailed:{"n":"2"}' }));
    fireEvent.click(screen.getByRole('button', { name: 'retryConfirm' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/legal-policies/terms/1.1/retry-failed', {});
    expect(await screen.findByText('retryStarted:{"n":"2"}')).toBeTruthy();
  });

  it('I1: a fee change too close to its effective date shows why and offers no Send; a 422 from Send says the same', async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        policies: [{ ...row('terms', true), canSend: false, sendBlocked: 'NOTICE_TOO_LATE' }],
      },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('tooLate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sendNotice' })).toBeNull();
    cleanup();
    apiGet.mockResolvedValue({ data: { policies: [row('terms', true)] }, error: null });
    apiPost.mockResolvedValue({
      data: null,
      error: { status: 422, code: 'NOTICE_TOO_LATE', message: 'x' },
    });
    render(<PolicyUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'sendNotice' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmSend' }));
    expect(await screen.findByText('tooLate')).toBeTruthy();
  });

  it('lists TIMEOUT_UNKNOWN rows separately as "may have been delivered", not under failed', async () => {
    apiGet.mockResolvedValue({
      data: {
        policies: [
          {
            ...row('terms', true, SENT),
            deliveries: { queued: 0, sending: 0, sent: 3, failed: 0 },
            failedDeliveries: [],
            unknownOutcome: 2,
            unknownDeliveries: [
              {
                maskedEmail: 'a***@example.com',
                error: 'TIMEOUT_UNKNOWN',
                at: '2026-10-21T10:05:00.000Z',
              },
              {
                maskedEmail: 'b***@example.com',
                error: 'TIMEOUT_UNKNOWN',
                at: '2026-10-21T10:06:00.000Z',
              },
            ],
          },
        ],
      },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('unknownTitle')).toBeTruthy();
    expect(screen.getByText(/^unknownHint:/).textContent).toContain('"n":"2"');
    expect(screen.getByText(/a\*\*\*@example\.com/)).toBeTruthy();
    expect(screen.queryByText('failedTitle')).toBeNull();
    // nothing retryable: no Retry failed button
    expect(screen.queryByRole('button', { name: /^retryFailed/ })).toBeNull();
  });

  it.each(['resume', 'retry'] as const)(
    '%s on a superseded version shows the NOT_CURRENT message',
    async action => {
      const failed = {
        ...row('terms', true, SENT),
        deliveries: { queued: 0, sending: 0, sent: 1, failed: 1 },
        stalled: true,
        failedDeliveries: [
          { maskedEmail: 'a***@example.com', error: 'x', at: '2026-10-21T10:05:00.000Z' },
        ],
      };
      apiGet.mockResolvedValue({ data: { policies: [failed] }, error: null });
      apiPost.mockResolvedValue({
        data: null,
        error: { status: 409, code: 'NOT_CURRENT', message: 'x' },
      });
      render(<PolicyUpdatesPage />);
      fireEvent.click(
        await screen.findByRole('button', { name: action === 'resume' ? 'resume' : /^retryFailed/ })
      );
      fireEvent.click(
        screen.getByRole('button', { name: action === 'resume' ? 'resumeConfirm' : 'retryConfirm' })
      );
      expect(await screen.findByText('notCurrent')).toBeTruthy();
      expect(screen.queryByText('actionFailed')).toBeNull();
    }
  );

  it('explains in the page how a version is published, and a non-material version has no Send notice', async () => {
    apiGet.mockResolvedValue({
      data: { policies: [row('privacy', false)] },
      error: null,
    });
    render(<PolicyUpdatesPage />);
    expect(await screen.findByText('howToTitle')).toBeTruthy();
    expect(screen.getByText('howToStep1')).toBeTruthy();
    expect(screen.getByText('howToNotMaterial')).toBeTruthy();
    expect(screen.queryByText('sendNotice')).toBeNull();
  });
});
