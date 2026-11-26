// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ar from '@/i18n/messages/ar.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
// A STABLE `t` per namespace: the page's fetch effect depends on it, a fresh function each render would loop.
const tCache = new Map<string, (k: string) => string>();
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => {
    if (!tCache.has(ns)) tCache.set(ns, (k: string) => lookup(ar, `${ns}.${k}`) ?? `${ns}.${k}`);
    return tCache.get(ns)!;
  },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 's1' }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../../../../components/AdminLayout', () => ({
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
vi.mock('@/components/mobile/DataTable', () => ({ DataTable: () => null }));
vi.mock('@/lib/plan-labels', () => ({ wholesalePlanName: () => '' }));
vi.mock('@/components/ui/Button', () => ({
  Button: ({
    children,
    onClick,
    type,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit';
  }) => (
    <button type={type ?? 'button'} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { groups: [] } })),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

import CustomerGroupsPage from './page';

afterEach(cleanup);

describe('QA-107: the new-group dialog never pre-ticks "default for new customers"', () => {
  it('is unticked even in a store with no groups yet', async () => {
    render(<CustomerGroupsPage />);
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText(ar.customerGroups.page.addNew));
    const box = (await screen.findByLabelText(
      ar.customerGroups.page.defaultLabel
    )) as HTMLInputElement;
    expect(box.checked).toBe(false);
  });
});
