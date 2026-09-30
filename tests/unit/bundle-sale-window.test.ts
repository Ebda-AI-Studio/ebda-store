/**
 * Issue 2111 — `withinSaleWindow` is the time half of a bundle's
 * `isPurchasable`, applied per request on top of the 120s public caches.
 * It must read the window the same whether it holds Dates (a cache miss) or
 * ISO strings (a cache hit: `getCached` round-trips through JSON).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@force/database', () => ({ prisma: {} }));

import { withinSaleWindow } from '@api/services/bundle.service';

const now = new Date('2026-10-01T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

describe('withinSaleWindow (issue 2111)', () => {
  it('no window = always inside', () => {
    expect(withinSaleWindow({ startsAt: null, expiresAt: null }, now)).toBe(true);
  });

  it('both bounds are inclusive', () => {
    expect(withinSaleWindow({ startsAt: now, expiresAt: null }, now)).toBe(true);
    expect(withinSaleWindow({ startsAt: null, expiresAt: now }, now)).toBe(true);
  });

  it('before startsAt and after expiresAt are outside', () => {
    expect(withinSaleWindow({ startsAt: at('2026-10-01T12:00:01Z'), expiresAt: null }, now)).toBe(
      false
    );
    expect(withinSaleWindow({ startsAt: null, expiresAt: at('2026-10-01T11:59:59Z') }, now)).toBe(
      false
    );
  });

  it('reads ISO strings (a cached payload) exactly like Dates', () => {
    const w = { startsAt: '2026-10-01T11:00:00.000Z', expiresAt: '2026-10-01T11:59:59.999Z' };
    expect(withinSaleWindow(w, now)).toBe(false);
    expect(withinSaleWindow({ ...w, expiresAt: '2026-10-01T12:00:00.000Z' }, now)).toBe(true);
  });

  it('treats an absent bound (an older cached shape) as unbounded, never as NaN-closed', () => {
    expect(withinSaleWindow({}, now)).toBe(true);
  });
});
