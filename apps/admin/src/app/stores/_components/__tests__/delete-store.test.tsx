// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { deleteStoreErrorKey } from '@/lib/delete-store-error';
import ar from '@/i18n/messages/ar.json';
import en from '@/i18n/messages/en.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    const s = lookup(ar, `${ns}.${k}`) ?? `${ns}.${k}`;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n]) : s;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const toastSuccess = vi.fn();
vi.mock('@ebda/ui', () => ({
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
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
  cn: (...a: string[]) => a.filter(Boolean).join(' '),
  useToast: () => ({ success: toastSuccess }),
}));
const apiDelete = vi.fn();
vi.mock('@/lib/api', () => ({ apiDelete: (...a: unknown[]) => apiDelete(...a) }));
const confirmMock = vi.fn();
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => confirmMock }));

import { StoresGrid } from '../StoresGrid';
import { StoresTable } from '../StoresTable';
import { useDeleteStore } from '../useDeleteStore';
import { DangerZone } from '../../[id]/_components/DangerZone';
import type { Store } from '../types';

const store: Store = {
  id: 's1',
  name: 'متجر تجريبي',
  slug: 'qa-merchant-test',
  domain: null,
  status: 'active',
  plan: 'free',
  createdAt: '2026-01-01T00:00:00Z',
  owner: { id: 'o', email: 'a@b.c', firstName: 'A', lastName: 'B' },
};

/** Mirrors stores/page.tsx: the row is removed from local state in onDeleted. */
function ListHarness({ isSuperAdmin, table }: { isSuperAdmin: boolean; table?: boolean }) {
  const [rows, setRows] = useState([store]);
  const { requestDelete, dialog } = useDeleteStore(d =>
    setRows(prev => prev.filter(s => s.id !== d.id))
  );
  const onDelete = isSuperAdmin ? requestDelete : undefined;
  return (
    <>
      <div data-testid="count">{rows.length}</div>
      {table ? (
        <StoresTable stores={rows} onDelete={onDelete} />
      ) : (
        <StoresGrid stores={rows} onDelete={onDelete} />
      )}
      {isSuperAdmin && dialog}
    </>
  );
}

const menuTrigger = () => screen.queryByRole('button', { name: /خيارات المتجر/ });
const openDialog = () => {
  fireEvent.click(menuTrigger()!);
  fireEvent.click(screen.getByRole('menuitem', { name: 'امسح المتجر' }));
};
const type = (v: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: v } });
const submitBtn = () =>
  within_dialog().find(b => b.textContent === 'امسح المتجر') as HTMLButtonElement;
const within_dialog = () =>
  Array.from(screen.getByRole('dialog').querySelectorAll('button')) as HTMLButtonElement[];

describe('super-admin delete store', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
  });

  it.each([
    ['grid', false],
    ['table', true],
  ])('(%s) shows the menu item only for super_admin', (_n, table) => {
    const { unmount } = render(<ListHarness isSuperAdmin={false} table={table} />);
    expect(menuTrigger()).toBeNull();
    unmount();
    render(<ListHarness isSuperAdmin table={table} />);
    fireEvent.click(menuTrigger()!);
    const items = screen.getAllByRole('menuitem');
    expect(items[items.length - 1].textContent).toBe('امسح المتجر');
  });

  it('keeps delete disabled until the slug is typed exactly', () => {
    render(<ListHarness isSuperAdmin />);
    openDialog();
    expect(submitBtn().disabled).toBe(true);
    type('qa-merchant');
    expect(submitBtn().disabled).toBe(true);
    type('QA-MERCHANT-TEST');
    expect(submitBtn().disabled).toBe(true);
    type('qa-merchant-test ');
    expect(submitBtn().disabled).toBe(true);
    type('qa-merchant-test');
    expect(submitBtn().disabled).toBe(false);
  });

  it.each([
    ['STORE_IS_BILLING_PARENT', 'المتجر الأساسي لفواتير'],
    ['STORE_HAS_MONEY_IN_FLIGHT', 'فلوس لسه في الطريق'],
  ])('409 %s shows the Arabic message and keeps the row', async (code, text) => {
    apiDelete.mockResolvedValue({ data: null, error: { code, status: 409, message: 'English' } });
    render(<ListHarness isSuperAdmin />);
    openDialog();
    type('qa-merchant-test');
    await act(async () => fireEvent.click(submitBtn()));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(text));
    expect(screen.getByRole('alert').textContent).not.toContain('English');
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('403 MFA_SETUP_REQUIRED shows the account-security link', async () => {
    apiDelete.mockResolvedValue({
      data: null,
      error: { code: 'MFA_SETUP_REQUIRED', status: 403, message: 'x' },
    });
    render(<ListHarness isSuperAdmin />);
    openDialog();
    type('qa-merchant-test');
    await act(async () => fireEvent.click(submitBtn()));
    await waitFor(() => expect(document.querySelector('a[href="/account/security"]')).toBeTruthy());
  });

  it('does not call the API when the final confirm is cancelled', async () => {
    confirmMock.mockResolvedValue(false);
    render(<ListHarness isSuperAdmin />);
    openDialog();
    type('qa-merchant-test');
    await act(async () => fireEvent.click(submitBtn()));
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('success calls DELETE, toasts, and removes the row', async () => {
    apiDelete.mockResolvedValue({ data: {}, error: null });
    render(<ListHarness isSuperAdmin />);
    openDialog();
    type('qa-merchant-test');
    await act(async () => fireEvent.click(submitBtn()));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0'));
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/stores/s1');
    expect(toastSuccess).toHaveBeenCalled();
    expect(confirmMock.mock.calls[0][0].tone).toBe('danger');
  });

  it('detail-page DangerZone uses the same flow', async () => {
    apiDelete.mockResolvedValue({ data: {}, error: null });
    const onDeleted = vi.fn();
    function Detail() {
      const { requestDelete, dialog } = useDeleteStore(onDeleted);
      return (
        <>
          <DangerZone
            status="active"
            isChangingStatus={false}
            onRequestSuspend={() => {}}
            onActivate={() => {}}
            onRequestDelete={() =>
              requestDelete({ id: store.id, name: store.name, slug: store.slug })
            }
          />
          {dialog}
        </>
      );
    }
    render(<Detail />);
    fireEvent.click(screen.getByRole('button', { name: 'حذف المتجر' }));
    expect(submitBtn().disabled).toBe(true);
    type('qa-merchant-test');
    await act(async () => fireEvent.click(submitBtn()));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(apiDelete).toHaveBeenCalledWith('/api/v1/stores/s1');
  });
});

describe('deleteStoreErrorKey + i18n', () => {
  it('maps the documented failures', () => {
    expect(deleteStoreErrorKey({ code: 'STORE_IS_BILLING_PARENT', status: 409 })).toBe(
      'errBillingParent'
    );
    expect(deleteStoreErrorKey({ code: 'MFA_SETUP_REQUIRED', status: 403 })).toBe('errMfaRequired');
    expect(deleteStoreErrorKey({ code: 'UNAUTHORIZED', status: 401 })).toBe('errSession');
    expect(deleteStoreErrorKey({ code: 'NETWORK_ERROR', status: 0 })).toBe('errNetwork');
    expect(deleteStoreErrorKey({ code: 'SERVER_ERROR', status: 500 })).toBeNull();
  });
  it('has matching keys in both languages, Western digits only', () => {
    type DeleteCopy = { stores: { deleteStore: Record<string, string> } };
    const a = (ar as unknown as DeleteCopy).stores.deleteStore;
    const e = (en as unknown as DeleteCopy).stores.deleteStore;
    expect(Object.keys(a)).toEqual(Object.keys(e));
    for (const v of [...Object.values<string>(a), ...Object.values<string>(e)])
      expect(v).not.toMatch(/[٠-٩]/);
  });
});
