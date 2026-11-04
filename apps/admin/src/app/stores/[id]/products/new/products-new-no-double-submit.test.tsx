// @vitest-environment jsdom
/**
 * UX:PN-1 / PN-3 / PN-2. Creating a product: one request even on a double click, no router.refresh(), lands on the
 * new product's edit page; a price under 0.01 is refused at the field; an Arabic-default store gets the Arabic name
 * first and the English one is optional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const push = vi.fn();
const refresh = vi.fn();
const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const lang = vi.hoisted(() => ({ value: 'ar' }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../../components/ImageUpload', () => ({ MultiImageUpload: () => null }));
vi.mock('@/components/SearchTermsField', () => ({ SearchTermsField: () => null }));
vi.mock('@/components/AITranslateMissingButton', () => ({ AITranslateMissingButton: () => null }));
vi.mock('../../../../../lib/auth', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../../lib/api', () => api);

import { ToastProvider } from '@ebda/ui';
import NewProductPage from './page';

const renderPage = () =>
  render(
    <ToastProvider>
      <NewProductPage />
    </ToastProvider>
  );

beforeEach(() => {
  api.apiGet.mockImplementation(async (url: string) =>
    url.includes('/admin/stores/')
      ? { data: { store: { settings: { defaultLanguage: lang.value } } } }
      : { data: { categories: [] } }
  );
  api.apiPost.mockImplementation(
    () => new Promise(resolve => setTimeout(() => resolve({ data: { product: { id: 'p1' } } }), 20))
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fill(nameLabel: string, price: string) {
  fireEvent.change(screen.getByLabelText(nameLabel), { target: { value: 'قميص' } });
  fireEvent.change(screen.getByLabelText('fields.price'), { target: { value: price } });
}

describe('new product form', () => {
  it('double submit posts once, never refreshes, and goes to the new edit page', async () => {
    renderPage();
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    await screen.findByLabelText('fields.nameAr');
    fill('fields.nameAr', '120');
    const form = document.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(push.mock.calls[0][0]).toContain('/stores/store-1/products/p1/edit?created=1');
    // the English name is empty: the Arabic one is sent as the required name
    expect(api.apiPost.mock.calls[0][1].name).toBe('قميص');
  });

  it('refuses a price under 0.01 at the field without a request', async () => {
    renderPage();
    await screen.findByLabelText('fields.nameAr');
    fill('fields.nameAr', '0');
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(await screen.findByText('errors.priceMin')).toBeTruthy();
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
