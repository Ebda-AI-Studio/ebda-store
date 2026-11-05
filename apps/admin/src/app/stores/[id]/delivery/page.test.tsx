// @vitest-environment jsdom
/**
 * Delivery page wiring for the "days with no delivery" chips: the stored selection loads, all
 * seven selected blocks Save, the chosen days reach the PUT payload sorted, and the untouched
 * default is never pinned into a store that had no saved value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut, toastError } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: toastError }),
}));
vi.mock('../shipping/_components/ShippingTabs', () => ({ ShippingTabs: () => null }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  usePathname: () => '/stores/store-1/delivery',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../../../lib/api', () => ({ apiGet, apiPut }));
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
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import CheckoutDeliveryPage from './page';

const load = (settings: Record<string, unknown>) =>
  apiGet.mockResolvedValue({ data: { store: { settings } }, error: null });
const chip = (day: number) => screen.getByText(`deliveryOffDay${day}`);
const pressed = () =>
  screen
    .getAllByRole('button')
    .filter(b => b.getAttribute('aria-pressed') === 'true')
    .map(b => b.textContent);
const saveButton = () => screen.getByText('save') as HTMLButtonElement;
// The sticky bar renders only while the form is dirty: type a minimum order to make it so.
const makeDirty = () =>
  fireEvent.change(screen.getByPlaceholderText('minOrderPlaceholder'), { target: { value: '50' } });
const savedSettings = () => apiPut.mock.calls[0][1].settings as Record<string, unknown>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('delivery page: days with no delivery', () => {
  it('loads the stored selection as pressed chips', async () => {
    load({ deliveryOffDays: [5, 6] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    expect(pressed()).toEqual(['deliveryOffDay6', 'deliveryOffDay5']);
  });

  it('refuses to save when all seven days are selected, and saves again below seven', async () => {
    load({ deliveryOffDays: [5] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    for (const d of [6, 0, 1, 2, 3, 4]) fireEvent.click(chip(d));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('errorTitle', 'deliveryOffDaysAllOff')
    );
    expect(apiPut).not.toHaveBeenCalled();
    fireEvent.click(chip(0));
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
  });

  it('sends the chosen days, sorted, in settings.deliveryOffDays', async () => {
    load({ deliveryOffDays: [5] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    fireEvent.click(chip(6));
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][0]).toBe('/api/v1/stores/store-1');
    expect(savedSettings().deliveryOffDays).toEqual([5, 6]);
  });

  it('does not pin the default into a store with no saved value', async () => {
    load({});
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    expect(pressed()).toEqual(['deliveryOffDay5']);
    makeDirty();
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect('deliveryOffDays' in savedSettings()).toBe(false);
  });

  it('keeps an explicit [5] when the store already saved one, and any non-default choice', async () => {
    load({ deliveryOffDays: [5] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    makeDirty();
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(savedSettings().deliveryOffDays).toEqual([5]);
  });

  it('sends an empty selection (deliver every day) as an explicit []', async () => {
    load({});
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    fireEvent.click(chip(5));
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(savedSettings().deliveryOffDays).toEqual([]);
  });
});
