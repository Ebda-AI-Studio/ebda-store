// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const sdkLoaded = vi.fn();
const init = vi.fn(async () => {});
const requestPermission = vi.fn(async () => {
  (globalThis as { Notification: { permission: string } }).Notification.permission = 'granted';
});
const optIn = vi.fn(async () => {});
const addTag = vi.fn(async () => {});
const sdk = {
  init,
  Notifications: { permission: false, requestPermission, addEventListener: vi.fn() },
  User: { addTag, PushSubscription: { optedIn: false, optIn, id: 'player-1' } },
};
// The factory runs when the module is first IMPORTED: a page load that never clicks must never trigger it.
vi.mock('react-onesignal', () => {
  sdkLoaded();
  return { default: sdk };
});

const apiGet = vi.fn();
const apiPost = vi.fn(async () => ({ data: {}, error: null }));
vi.mock('../../apps/admin/src/lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));
vi.mock('../../apps/admin/src/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'store_admin' } }),
}));
vi.mock('../../apps/admin/src/contexts/StoreContext', () => ({
  useStore: () => ({ selectedStoreId: 's1' }),
}));
vi.mock('../../apps/admin/src/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));

import { EnableOrderAlertsButton } from '../../apps/admin/src/components/EnableOrderAlertsButton';

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { Notification?: unknown }).Notification = { permission: 'default' };
  apiGet.mockResolvedValue({ data: { enabled: true, appId: 'app-1' }, error: null });
});

describe('<EnableOrderAlertsButton>', () => {
  it('does not load the SDK or call the API on render (page load)', () => {
    render(<EnableOrderAlertsButton />);
    expect(screen.getByRole('button').textContent).toBe('cta');
    expect(sdkLoaded).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('a click loads the SDK, hides its slidedown, asks permission, tags the store and records the device', async () => {
    render(<EnableOrderAlertsButton />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('doneHint'));
    expect(sdkLoaded).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', serviceWorkerPath: '/OneSignalSDKWorker.js' })
    );
    expect(requestPermission).toHaveBeenCalled();
    expect(optIn).toHaveBeenCalled();
    expect(addTag).toHaveBeenCalledWith('store_id', 's1');
    expect(apiPost).toHaveBeenCalledWith(
      '/api/v1/admin/notifications/onesignal/subscribe',
      expect.objectContaining({ playerId: 'player-1' })
    );
    expect(document.getElementById('ebda-hide-onesignal-prompts')).not.toBeNull();
  });

  it('a browser that already blocks notifications never loads the SDK', async () => {
    (globalThis as { Notification: { permission: string } }).Notification.permission = 'denied';
    render(<EnableOrderAlertsButton />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('denied'));
    expect(sdkLoaded).not.toHaveBeenCalled();
  });

  it('push not configured -> says unavailable, SDK stays unloaded', async () => {
    apiGet.mockResolvedValue({ data: { enabled: false, appId: '' }, error: null });
    render(<EnableOrderAlertsButton />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('unavailable'));
    expect(sdkLoaded).not.toHaveBeenCalled();
  });
});

import { safeSameOriginUrl } from '../../apps/admin/src/lib/push-opt-in';
describe('safeSameOriginUrl', () => {
  it('only same-origin http(s)', () => {
    expect(safeSameOriginUrl('/stores/a/orders/1', 'https://store.ebda.app')).toBe(
      'https://store.ebda.app/stores/a/orders/1'
    );
    expect(safeSameOriginUrl('javascript:alert(1)', 'https://store.ebda.app')).toBeNull();
    expect(safeSameOriginUrl('https://evil.example/x', 'https://store.ebda.app')).toBeNull();
    expect(safeSameOriginUrl(null, 'https://store.ebda.app')).toBeNull();
  });
});
