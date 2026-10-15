// @vitest-environment jsdom
/**
 * Delivery page wiring for the "days with no delivery" chips: the stored selection loads, all
 * seven selected blocks Save, the chosen days reach the PUT payload sorted, and the untouched
 * default is never pinned into a store that had no saved value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
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

  it('disables Save once all seven days are selected, and re-enables it below seven', async () => {
    load({ deliveryOffDays: [5] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
    expect(saveButton().disabled).toBe(false);
    for (const d of [6, 0, 1, 2, 3, 4]) fireEvent.click(chip(d));
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(chip(0));
    expect(saveButton().disabled).toBe(false);
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
    apiPut.mockResolvedValue({ error: null });
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect('deliveryOffDays' in savedSettings()).toBe(false);
  });

  it('keeps an explicit [5] when the store already saved one, and any non-default choice', async () => {
    load({ deliveryOffDays: [5] });
    render(<CheckoutDeliveryPage />);
    await screen.findByText('deliveryOffDay5');
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
