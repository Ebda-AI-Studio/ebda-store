// @vitest-environment jsdom
/** Reorder rule form: the API's field-level validation error renders under the field it names. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('@/lib/api', async importActual => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  apiGet,
  apiPost,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/PageState', () => ({
  PageState: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/RowActions', () => ({ RowActions: () => null }));
vi.mock('@/components/mobile/DataTable', () => ({ DataTable: () => null }));
vi.mock('@/components/ui/Button', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({
    children,
    actions,
  }: {
    children: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

import ReorderRulesPage from './page';

beforeEach(() => {
  apiGet.mockImplementation((url: string) =>
    Promise.resolve({
      data: url.includes('/products?')
        ? { products: [{ id: 'p1', name: 'Tee', sku: 'T1' }] }
        : url.includes('reorder-rules')
          ? []
          : [],
      error: null,
    })
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('reorder rule form', () => {
  it('renders the API field error under the quantity field it names', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { message: 'bad', status: 400, details: { reorderQty: ['Must be at least 1'] } },
    });
    const { container } = render(<ReorderRulesPage />);
    fireEvent.click(await screen.findByText('newButton'));
    await screen.findByText('[T1] Tee');
    fireEvent.change(container.querySelector('select')!, { target: { value: 'p1' } });
    const nums = container.querySelectorAll('input[type="number"]');
    fireEvent.change(nums[0], { target: { value: '1' } });
    fireEvent.change(nums[1], { target: { value: '5' } });
    fireEvent.change(nums[2], { target: { value: '2' } });
    fireEvent.change(nums[3], { target: { value: '2' } });
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const msg = await screen.findByText('Must be at least 1');
    expect(msg.closest('label')?.textContent).toContain('form.reorderQty');
  });
});
