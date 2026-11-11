/**
 * Page load only RESUMES an already-granted push subscription (audit G-1): silent, no prompt, no subscribe.
 * Behaviour test: the real `resumeGrantedAlerts` runs against a faked OneSignal SDK, a faked `Notification`
 * permission and a faked config call. (Replaces a source-text window that sliced the function out by position.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  sdk: {
    init: vi.fn(async () => undefined),
    Notifications: {
      permission: true,
      requestPermission: vi.fn(async () => true),
      addEventListener: vi.fn(),
    },
    User: {
      addTag: vi.fn(async () => undefined),
      PushSubscription: { optedIn: false, optIn: vi.fn(async () => undefined), id: 'p1' },
    },
  },
}));

vi.mock('../../apps/admin/src/lib/api', () => ({ apiGet: h.apiGet, apiPost: h.apiPost }));
vi.mock('react-onesignal', () => ({ default: h.sdk }));

async function loadFresh() {
  vi.resetModules(); // the module caches the SDK promise per page
  return import('../../apps/admin/src/lib/push-opt-in');
}

function stubBrowser(permission: NotificationPermission) {
  vi.stubGlobal('window', {
    location: { origin: 'https://store.ebda.app', href: 'x', assign: vi.fn() },
  });
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild: vi.fn() },
  });
}

const touchedSubscribe = () =>
  h.sdk.Notifications.requestPermission.mock.calls.length +
  h.sdk.User.PushSubscription.optIn.mock.calls.length +
  h.sdk.User.addTag.mock.calls.length +
  h.apiPost.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  h.apiGet.mockResolvedValue({ data: { appId: 'app-1', enabled: true } });
});
afterEach(() => vi.unstubAllGlobals());

describe('resumeGrantedAlerts (page load)', () => {
  it.each(['default', 'denied'] as const)(
    'permission %s: does nothing, loads no SDK, asks for nothing',
    async permission => {
      stubBrowser(permission);
      const { resumeGrantedAlerts } = await loadFresh();
      await resumeGrantedAlerts();
      expect(h.apiGet).not.toHaveBeenCalled();
      expect(h.sdk.init).not.toHaveBeenCalled();
      expect(touchedSubscribe()).toBe(0);
    }
  );

  it('permission granted: starts the SDK silently and never prompts, opts in, tags or subscribes', async () => {
    stubBrowser('granted');
    const { resumeGrantedAlerts } = await loadFresh();
    await resumeGrantedAlerts();
    expect(h.sdk.init).toHaveBeenCalledTimes(1);
    expect(h.sdk.Notifications.addEventListener).toHaveBeenCalledWith(
      'click',
      expect.any(Function)
    );
    expect(touchedSubscribe()).toBe(0);
  });

  it('permission granted but push not configured: no SDK, no throw', async () => {
    stubBrowser('granted');
    h.apiGet.mockResolvedValue({ data: { appId: '', enabled: false } });
    const { resumeGrantedAlerts } = await loadFresh();
    await expect(resumeGrantedAlerts()).resolves.toBeUndefined();
    expect(h.sdk.init).not.toHaveBeenCalled();
  });
});
