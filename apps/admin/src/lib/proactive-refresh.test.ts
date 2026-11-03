/** P0 logout audit: renew the 5-minute token ~60 s before expiry, once across tabs; reactive refresh stays the fallback. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  armProactiveRefresh,
  disarmProactiveRefresh,
  PROACTIVE_LEAD_MS,
} from './proactive-refresh';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disarmProactiveRefresh();
  vi.useRealTimers();
});

describe('armProactiveRefresh', () => {
  it('fires about 60 s before the token expires, not earlier', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const expiresAt = Date.now() + 5 * 60_000;
    armProactiveRefresh(expiresAt, { refresh, withLock: fn => fn() });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - PROACTIVE_LEAD_MS - 1000);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('re-arming replaces the previous timer (one timer, not a stampede)', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const deps = { refresh, withLock: (fn: () => Promise<void>) => fn() };
    armProactiveRefresh(Date.now() + 5 * 60_000, deps);
    armProactiveRefresh(Date.now() + 5 * 60_000, deps);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('an already-near expiry refreshes right away', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    armProactiveRefresh(Date.now() + 10_000, { refresh, withLock: fn => fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when another tab holds the lock (it renews the shared cookie)', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    armProactiveRefresh(Date.now() + 5 * 60_000, { refresh, withLock: async () => undefined });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('disarm cancels it', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    armProactiveRefresh(Date.now() + 5 * 60_000, { refresh, withLock: fn => fn() });
    disarmProactiveRefresh();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
