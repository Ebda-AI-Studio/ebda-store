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

import {
  OrderAlertsPromptCard,
  orderAlertsDismissKey,
  SESSION_VIEWS_KEY,
  SESSION_GRACE_MS,
} from './OrderAlertsPromptCard';

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
const session = new Map<string, string>();
const store = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
});
/** A later page view in the session: the 10 s grace no longer applies. */
const secondView = () => session.set(SESSION_VIEWS_KEY, '1');
beforeEach(() => {
  memory.clear();
  session.clear();
  secondView();
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: store(session) });
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

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

  it('is a labelled modal dialog with focus on the primary button', async () => {
    setPush('default');
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(CTA);
  });

  it('Esc closes it as "later" (records the dismissal)', async () => {
    setPush('default');
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(memory.get(orderAlertsDismissKey('u1'))).toBeTruthy();
  });

  it('traps Tab inside the dialog in both directions', async () => {
    setPush('default');
    api();
    render(<OrderAlertsPromptCard storeId="s1" />);
    const dialog = await screen.findByRole('dialog');
    const primary = screen.getByText(CTA);
    const later = screen.getByText('components.orderAlertsPrompt.later');
    later.focus();
    fireEvent.keyDown(later, { key: 'Tab' });
    expect(document.activeElement).toBe(primary);
    primary.focus();
    fireEvent.keyDown(primary, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(later);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the opener when closed', async () => {
    setPush('default');
    api();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(<OrderAlertsPromptCard storeId="s1" />);
    fireEvent.click(await screen.findByText('components.orderAlertsPrompt.later'));
    expect(document.activeElement).toBe(opener);
  });

  it('never shows on top of another open dialog', async () => {
    setPush('default');
    api();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    document.body.appendChild(other);
    render(<OrderAlertsPromptCard storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(CTA)).toBeNull();
  });

  it('waits out the grace period on the first page view of a session', async () => {
    setPush('default');
    api();
    session.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<OrderAlertsPromptCard storeId="s1" />);
    await vi.advanceTimersByTimeAsync(SESSION_GRACE_MS - 500);
    expect(screen.queryByText(CTA)).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await screen.findByText(CTA)).toBeTruthy();
  });
});
