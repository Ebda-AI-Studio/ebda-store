// @vitest-environment jsdom
/** Webhook endpoint form: the API's field-level validation error renders under the field it names. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('../../../../lib/api', async importActual => ({
  ...(await importActual<typeof import('../../../../lib/api')>()),
  apiGet,
  apiPost,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => {
  const t = Object.assign((key: string) => key, { has: () => false });
  return { useT: () => t };
});
vi.mock('@/components/ui/Button', () => ({
  Button: ({
    isLoading: _l,
    ...p
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => <button {...p} />,
}));
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
vi.mock('@ebda/ui', () => ({
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

import WebhooksPage from './page';

beforeEach(() => {
  apiGet.mockResolvedValue({ data: { endpoints: [] }, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('webhook endpoint form', () => {
  it('renders the API field error under the url field', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { message: 'bad', status: 400, details: { url: ['URL is not allowed'] } },
    });
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByText('actions.add'));
    fireEvent.change(screen.getByPlaceholderText('form.urlPlaceholder'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByText('form.save'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const msg = await screen.findAllByText('URL is not allowed');
    expect(msg.some(m => m.closest('label')?.textContent?.includes('form.urlLabel'))).toBe(true);
  });
});
