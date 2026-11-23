// @vitest-environment jsdom
/** Staff invite form: the API's field-level validation error renders under the field it names. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('@/lib/api', async importActual => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  apiGet,
  apiPost,
  apiDelete: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'store_admin' } }) }));
vi.mock('@/i18n/useT', () => {
  const t = Object.assign((key: string) => key, { rich: (key: string) => key });
  return { useT: () => t };
});
vi.mock('@/hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: null }),
}));
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
vi.mock('@/components/mobile/DataTable', () => ({ DataTable: () => null }));
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import StaffPage from './page';

beforeEach(() => {
  apiGet.mockResolvedValue({ data: { staff: [], invites: [] }, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('staff invite form', () => {
  it('renders the API field error under the email field', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { message: 'bad', status: 400, details: { email: ['Invalid email address'] } },
    });
    const { container } = render(<StaffPage />);
    fireEvent.click(await screen.findByText('page.addButton'));
    const form = container.querySelector('#staff-email')!.closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const msg = await screen.findAllByText('Invalid email address');
    expect(msg.length).toBeGreaterThan(0);
  });
});
