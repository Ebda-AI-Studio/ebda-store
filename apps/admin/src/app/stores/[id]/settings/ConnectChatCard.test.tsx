// @vitest-environment jsdom
/**
 * CHAT-ENABLE-1 Store half: the Connect Ebda Chat card. Shown to the owner / store admin only; one
 * POST per click run (double click = one request); every refusal is its own sentence; the linked
 * state names where to open Chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { apiGet, apiPost, toast, auth } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  auth: { role: 'store_admin' },
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => toast,
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPost }));

import { ConnectChatCard, CHAT_URL, refusalKey } from './ConnectChatCard';

const URL_ = '/api/v1/stores/s1/whatsapp-link';
const notLinked = { data: { linked: false, entitled: true, active: false }, error: null };

beforeEach(() => {
  auth.role = 'store_admin';
  apiGet.mockReset().mockResolvedValue(notLinked);
  apiPost.mockReset();
  toast.success.mockReset();
});
afterEach(cleanup);

describe('ConnectChatCard', () => {
  it('is not rendered for staff and does not even read the link state', () => {
    auth.role = 'staff';
    const { container } = render(<ConnectChatCard storeId="s1" />);
    expect(container.firstChild).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('happy path: connect posts once, flips to connected and links to Chat', async () => {
    apiPost.mockResolvedValue({ data: { linked: true }, error: null });
    render(<ConnectChatCard storeId="s1" />);
    expect(await screen.findByText('whatItDoes')).toBeTruthy();
    fireEvent.click(screen.getByText('connect'));
    await screen.findByTestId('chat-connected');
    expect(apiPost).toHaveBeenCalledWith(URL_);
    expect(toast.success).toHaveBeenCalledTimes(1);
    const open = screen.getByText('openChat').closest('a')!;
    expect(open.getAttribute('href')).toBe(CHAT_URL);
    expect(screen.queryByText('connect')).toBeNull();
  });

  it('a double click sends ONE request', async () => {
    let done!: (v: unknown) => void;
    apiPost.mockReturnValue(new Promise(r => (done = r)));
    render(<ConnectChatCard storeId="s1" />);
    const btn = await screen.findByText('connect');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(apiPost).toHaveBeenCalledTimes(1);
    done({ data: { linked: true }, error: null });
    await screen.findByTestId('chat-connected');
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('refusal: a plan without Chat shows the plan sentence and keeps the button usable', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'WHATSAPP_NOT_INCLUDED', status: 403, message: 'raw english' },
    });
    render(<ConnectChatCard storeId="s1" />);
    fireEvent.click(await screen.findByText('connect'));
    const msg = await screen.findByTestId('chat-refusal');
    expect(msg.textContent).toContain('notIncluded');
    expect(msg.textContent).not.toContain('raw english');
    await waitFor(() =>
      expect((screen.getByText('connect') as HTMLButtonElement).disabled).toBe(false)
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a store whose plan lacks Chat is told so before clicking, with a link to billing', async () => {
    apiGet.mockResolvedValue({
      data: { linked: false, entitled: false, active: false },
      error: null,
    });
    render(<ConnectChatCard storeId="s1" />);
    expect(await screen.findByTestId('chat-not-included')).toBeTruthy();
    expect(screen.getByText('upgrade').closest('a')!.getAttribute('href')).toBe(
      '/stores/s1/billing'
    );
    expect((screen.getByText('connect') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an unreadable state is an error with Retry, never "not connected"', async () => {
    apiGet.mockResolvedValueOnce({ data: null, error: { status: 500, code: 'X', message: '' } });
    render(<ConnectChatCard storeId="s1" />);
    expect(await screen.findByText('errLoad')).toBeTruthy();
    expect(screen.queryByText('connect')).toBeNull();
    fireEvent.click(screen.getByText('retry'));
    expect(await screen.findByText('connect')).toBeTruthy();
  });

  it('already connected on load shows connected without a connect button', async () => {
    apiGet.mockResolvedValue({ data: { linked: true, entitled: true, active: true }, error: null });
    render(<ConnectChatCard storeId="s1" />);
    await screen.findByTestId('chat-connected');
    expect(screen.queryByText('connect')).toBeNull();
  });
});

describe('refusalKey', () => {
  it.each([
    [{ code: 'WHATSAPP_NOT_INCLUDED', status: 403 }, 'notIncluded'],
    [{ code: 'MFA_SETUP_REQUIRED', status: 403 }, 'errMfa'],
    [{ code: 'FORBIDDEN', status: 403 }, 'errRole'],
    [{ code: 'TOKEN_INVALID', status: 401 }, 'errSession'],
    [{ code: 'NETWORK', status: 0 }, 'errNetwork'],
    [{ code: 'X', status: 500 }, 'errGeneric'],
  ])('%j -> %s', (e, key) => expect(refusalKey(e)).toBe(key));
});
