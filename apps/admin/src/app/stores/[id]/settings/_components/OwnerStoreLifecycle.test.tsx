// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import en from '@/i18n/messages/en.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    const s = lookup(en, `${ns}.${k}`) ?? `${ns}.${k}`;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n]) : s;
  },
}));
vi.mock('@ebda/ui', () => ({
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  useToast: () => ({ success: vi.fn() }),
}));
vi.mock('@/components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock('@/lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiDelete: (...a: unknown[]) => apiDelete(...a),
  apiFetch: vi.fn(),
}));

import { OwnerStoreLifecycle } from './OwnerStoreLifecycle';

beforeEach(() => {
  cleanup();
  apiGet.mockReset().mockResolvedValue({ data: { request: null, isOwner: true }, error: null });
  apiPost.mockReset();
  apiDelete.mockReset();
});

describe('OwnerStoreLifecycle', () => {
  it('renders nothing for a non-owner (the status read is refused)', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { code: 'OWNER_ONLY', status: 403, message: 'x' },
    });
    const { container } = render(<OwnerStoreLifecycle storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows named refusal reasons and no slug field when the guards refuse', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: {
        code: 'STORE_HAS_MONEY_IN_FLIGHT',
        status: 409,
        message: 'm',
        details: { reasons: [{ code: 'STORE_HAS_MONEY_IN_FLIGHT', message: 'm' }] },
      },
    });
    render(<OwnerStoreLifecycle storeId="s1" />);
    fireEvent.click(await screen.findByText('Delete this store', { selector: 'button' }));
    expect(await screen.findByText(/money in flight/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Type the store address/)).toBeNull();
  });

  it('submit stays disabled until the slug is typed exactly, then POSTs the token + slug once', async () => {
    apiPost.mockResolvedValueOnce({
      data: {
        slug: 'shop-a',
        storeName: 'Shop A',
        coolingOffDays: 14,
        confirmToken: 'tok.tok.tok',
      },
      error: null,
    });
    apiPost.mockResolvedValueOnce({ data: { executeAfter: '2026-11-28T10:00:00Z' }, error: null });
    render(<OwnerStoreLifecycle storeId="s1" />);
    fireEvent.click(await screen.findByText('Delete this store', { selector: 'button' }));
    const input = (await screen.findByLabelText(/Type the store address/)) as HTMLInputElement;
    const submit = screen.getByText('Schedule deletion') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Shop-A' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'shop-a' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenLastCalledWith('/api/v1/stores/s1/deletion', {
      confirmToken: 'tok.tok.tok',
      typedSlug: 'shop-a',
    });
  });

  it('a pending request shows the date and a cancel button that calls DELETE once', async () => {
    apiGet.mockResolvedValue({
      data: { request: { id: 'r1', state: 'pending', executeAfter: '2026-11-28T10:00:00Z' } },
      error: null,
    });
    apiDelete.mockResolvedValue({ data: {}, error: null });
    render(<OwnerStoreLifecycle storeId="s1" />);
    expect(await screen.findByText(/deleted on 2026-11-28/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel the deletion'));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1));
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/stores/s1/deletion');
  });

  it('a super admin who is not the owner sees only the pending deletion and can cancel it (no export, no delete dialog)', async () => {
    apiGet.mockResolvedValue({
      data: {
        request: { id: 'r1', state: 'pending', executeAfter: '2026-11-28T10:00:00Z' },
        isOwner: false,
      },
      error: null,
    });
    render(<OwnerStoreLifecycle storeId="s1" />);
    expect(await screen.findByText(/deleted on 2026-11-28/)).toBeTruthy();
    expect(screen.queryByText('Download my data')).toBeNull();
    expect(screen.getByText('Cancel the deletion')).toBeTruthy();
  });

  it('an owner with nothing pending sees nothing for a non-owner with nothing pending', async () => {
    apiGet.mockResolvedValue({ data: { request: null, isOwner: false }, error: null });
    const { container } = render(<OwnerStoreLifecycle storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('while executing there is no cancel button, only the running notice', async () => {
    apiGet.mockResolvedValue({
      data: {
        request: { id: 'r1', state: 'executing', executeAfter: '2026-11-28T10:00:00Z' },
        isOwner: true,
      },
      error: null,
    });
    render(<OwnerStoreLifecycle storeId="s1" />);
    expect(await screen.findByText(/can no longer be cancelled/)).toBeTruthy();
    expect(screen.queryByText('Cancel the deletion')).toBeNull();
  });

  it('a stuck deletion shows the paused notice and the last reason, still no cancel button', async () => {
    apiGet.mockResolvedValue({
      data: {
        request: {
          id: 'r1',
          state: 'executing',
          executeAfter: '2026-11-28T10:00:00Z',
          stuckAt: '2026-11-28T11:00:00Z',
          failures: 3,
          lastFailure: { message: 'd1 down' },
        },
        isOwner: true,
      },
      error: null,
    });
    render(<OwnerStoreLifecycle storeId="s1" />);
    expect(await screen.findByText(/paused/)).toBeTruthy();
    expect(screen.getByText('d1 down')).toBeTruthy();
    expect(screen.queryByText('Cancel the deletion')).toBeNull();
  });
});
