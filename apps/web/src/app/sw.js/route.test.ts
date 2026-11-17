import { describe, expect, it, vi } from 'vitest';

/** PW1: /sw.js is the real worker while the phone app is on, a kill-switch while it is off. */
const store = { current: {} as Record<string, unknown> };
vi.mock('../../lib/store-resolver', () => ({ getStore: async () => store.current }));

const { GET } = await import('./route');
const body = async () => (await GET()).text();

describe('/sw.js route', () => {
  it('switch ON: the real worker (push handlers), not the kill-switch', async () => {
    store.current = { id: 's1', pwaEnabled: true, enabledFeatures: ['pwa'] };
    const t = await body();
    expect(t).toContain("addEventListener('push'");
    expect(t).not.toContain('unregister()');
  });

  it('switch OFF, never set, or feature off: kill-switch that clears caches, claims and unregisters', async () => {
    for (const s of [
      { id: 's1', pwaEnabled: false },
      { id: 's1' },
      { id: 's1', pwaEnabled: true, enabledFeatures: ['reviews'] },
    ]) {
      store.current = s;
      const t = await body();
      expect(t).toContain('skipWaiting()');
      expect(t).toContain('caches.delete');
      expect(t).toContain('clients.claim()');
      expect(t).toContain('self.registration.unregister()');
      expect(t).not.toContain("addEventListener('push'");
    }
  });

  it('is revalidated on every update check and served as JavaScript', async () => {
    const res = await GET();
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
  });
});
