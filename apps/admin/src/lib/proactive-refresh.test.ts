/** P0 logout audit: renew the 5-minute token ~60 s before expiry, once across tabs; reactive refresh stays the fallback. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  armProactiveRefresh,
  disarmProactiveRefresh,
  PROACTIVE_LEAD_MS,
  PROACTIVE_MIN_DELAY_MS,
  grantExpiryMs,
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

  it('an already-near expiry refreshes after the minimum delay, never in a zero-delay loop', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    armProactiveRefresh(Date.now() + 10_000, { refresh, withLock: fn => fn() });
    await vi.advanceTimersByTimeAsync(PROACTIVE_MIN_DELAY_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a refresh that re-arms with an already-expired deadline fires at most once per minimum delay', async () => {
    const deps = {
      refresh: vi.fn(async () => {
        armProactiveRefresh(Date.now() - 60_000, deps); // what a skewed device clock produced
      }),
      withLock: (fn: () => Promise<void>) => fn(),
    };
    armProactiveRefresh(Date.now() - 60_000, deps);
    await vi.advanceTimersByTimeAsync(5 * PROACTIVE_MIN_DELAY_MS);
    expect(deps.refresh.mock.calls.length).toBeLessThanOrEqual(5);
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

describe('grantExpiryMs is independent of the device clock', () => {
  const jwt = (p: object) => `h.${btoa(JSON.stringify(p))}.s`;
  it('uses the token lifetime (exp - iat) from the moment of receipt, even with a clock far ahead', () => {
    const serverNow = 1_800_000_000; // seconds
    const token = jwt({ iat: serverNow, exp: serverNow + 900 });
    vi.setSystemTime(new Date((serverNow + 3600) * 1000)); // device clock one hour ahead
    expect(grantExpiryMs({ access_token: token }) - Date.now()).toBe(900_000);
  });

  it('ignores an expires_at that is already past on this device (clock skew) instead of returning a past deadline', () => {
    vi.setSystemTime(new Date(2_000_000_000_000));
    const past = 1_800_000_000;
    expect(grantExpiryMs({ access_token: 'opaque', expires_at: past }) - Date.now()).toBe(240_000);
  });
});
