// @vitest-environment jsdom
/**
 * Dashboard order-alerts ask: inline card, shown only when push is supported, permission is 'default', the
 * merchant has an order or finished setup, and it was not dismissed in the last 14 days. Only the click loads
 * the SDK (enableOrderAlerts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, enableOrderAlerts } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  enableOrderAlerts: vi.fn(),
}));
vi.mock('../lib/api', () => ({ apiGet }));
vi.mock('../lib/push-opt-in', () => ({ enableOrderAlerts }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'store_admin' } }) }));
vi.mock('../contexts/StoreContext', () => ({ useStore: () => ({ selectedStoreId: 's1' }) }));
vi.mock('@/i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns}.${key}`,
}));

import { OrderAlertsPromptCard, orderAlertsDismissKey } from './OrderAlertsPromptCard';

function setPush(permission: NotificationPermission | null) {
  if (permission === null) {
    delete (window as unknown as Record<string, unknown>).Notification;
    return;
  }
  (window as unknown as Record<string, unknown>).Notification = { permission };
  (window as unknown as Record<string, unknown>).PushManager = class {};
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
}
function api({ orders = 3, guideDone = false } = {}) {
  apiGet.mockImplementation(async (url: string) =>
    url.endsWith('/stats')
      ? { data: { orderCount: orders } }
      : { data: { requiredDone: guideDone ? 4 : 1, requiredTotal: 4 } }
  );
}
const CTA = 'components.orderAlertsPrompt.cta';

const memory = new Map<string, string>();
beforeEach(() => {
  memory.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    },
  });
  apiGet.mockReset();
  enableOrderAlerts.mockReset();
});
afterEach(cleanup);

describe('OrderAlertsPromptCard', () => {
  it('shows when eligible (has orders)', async () => {
    setPush('default');
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    expect(await screen.findByText(CTA)).toBeTruthy();
    expect(screen.getByText('components.orderAlertsPrompt.later')).toBeTruthy();
  });

  it('shows when the setup guide is finished and there are no orders yet', async () => {
    setPush('default');
    api({ orders: 0, guideDone: true });
    render(<OrderAlertsPromptCard storeId="s1" />);
    expect(await screen.findByText(CTA)).toBeTruthy();
  });

  it('stays hidden for a brand-new merchant (no orders, setup unfinished)', async () => {
    setPush('default');
    api({ orders: 0 });
    render(<OrderAlertsPromptCard storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByText(CTA)).toBeNull();
  });

  it.each([['granted'], ['denied']] as const)('stays hidden when permission is %s', async p => {
    setPush(p);
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    await Promise.resolve();
    expect(screen.queryByText(CTA)).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('stays hidden when the browser has no push support', async () => {
    setPush(null);
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    await Promise.resolve();
    expect(screen.queryByText(CTA)).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('stays hidden for 14 days after "not now", then returns', async () => {
    setPush('default');
    api();
    window.localStorage.setItem(orderAlertsDismissKey('u1'), String(Date.now() - 2 * 86_400_000));
    const { unmount } = render(<OrderAlertsPromptCard storeId="s1" />);
    await Promise.resolve();
    expect(screen.queryByText(CTA)).toBeNull();
    unmount();
    window.localStorage.setItem(orderAlertsDismissKey('u1'), String(Date.now() - 15 * 86_400_000));
    render(<OrderAlertsPromptCard storeId="s1" />);
    expect(await screen.findByText(CTA)).toBeTruthy();
  });

  it('"not now" hides the card and records the dismissal without loading the SDK', async () => {
    setPush('default');
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    fireEvent.click(await screen.findByText('components.orderAlertsPrompt.later'));
    expect(screen.queryByText(CTA)).toBeNull();
    expect(window.localStorage.getItem(orderAlertsDismissKey('u1'))).toBeTruthy();
    expect(enableOrderAlerts).not.toHaveBeenCalled();
  });

  it('nothing is enabled before the click; the click calls enableOrderAlerts', async () => {
    setPush('default');
    api();
    enableOrderAlerts.mockResolvedValue('enabled');
    render(<OrderAlertsPromptCard storeId="s1" />);
    const btn = await screen.findByText(CTA);
    expect(enableOrderAlerts).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(enableOrderAlerts).toHaveBeenCalledWith({
        userId: 'u1',
        role: 'store_admin',
        storeId: 's1',
      })
    );
    await waitFor(() => expect(screen.queryByText(CTA)).toBeNull());
  });
});
