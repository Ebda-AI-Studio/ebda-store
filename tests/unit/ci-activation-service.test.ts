/** Ruling ACT-1: the super-admin read side. Keyset-paged store list (one R2 get per store on the page) and the date-range funnel. */
import { describe, expect, it, vi } from 'vitest';

const { dir } = vi.hoisted(() => ({
  dir: { v: [] as Array<{ id: string; slug: string; name: string; status: string }> },
}));
vi.mock('@ebda/database', () => ({ storeDirectory: async () => dir.v }));

import {
  activationFunnel,
  listActivation,
  FUNNEL_STORE_CAP,
} from '../../apps/api/src/services/ci-activation.service';
import { ciStoreActivationKey } from '../../apps/api/src/lib/ci/layout';
import type { ActivationFile } from '../../apps/api/src/lib/ci/aggregate/activation-file';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SIGNUP = Date.parse('2026-11-03T09:00:00Z');
const file = (n: number, secs: number[]): ActivationFile => ({
  v: 1,
  storeId: id(n),
  signupAt: SIGNUP,
  steps: Object.fromEntries(
    ['store_created', 'payment_methods']
      .slice(0, secs.length)
      .map((s, i) => [s, { at: SIGNUP + secs[i]! * 1000, secondsSinceSignup: secs[i]! }])
  ),
  firstOrder: null,
  help: {},
  trail: {},
});
function bucket(files: Record<string, ActivationFile>) {
  const get = vi.fn(async (k: string) => {
    const f = Object.entries(files).find(([sid]) => ciStoreActivationKey(sid) === k)?.[1];
    return f ? { text: async () => JSON.stringify(f) } : null;
  });
  return { get } as never;
}

describe('activation service', () => {
  it('pages with a keyset cursor on id and reads one file per store on the page', async () => {
    dir.v = [3, 1, 2].map(n => ({
      id: id(n),
      slug: `s${n}`,
      name: `Store ${n}`,
      status: 'active',
    }));
    const ci = bucket({ [id(1)]: file(1, [60, 600]) });
    const p1 = await listActivation({ limit: 2 }, ci);
    expect(p1.rows.map(r => r.storeId)).toEqual([id(1), id(2)]);
    expect(p1.nextCursor).toBe(id(2));
    expect(p1.rows[0]!.steps[1]).toMatchObject({ step: 'payment_methods', secondsFromSignup: 600 });
    expect(p1.rows[1]!.steps.every(s => !s.reached)).toBe(true);
    expect((ci as unknown as { get: { mock: { calls: unknown[] } } }).get.mock.calls).toHaveLength(
      2
    );
    const p2 = await listActivation({ limit: 2, cursor: p1.nextCursor! }, ci);
    expect(p2.rows.map(r => r.storeId)).toEqual([id(3)]);
    expect(p2.nextCursor).toBeNull();
  });

  it('answers unavailable without bindings, and caps the limit', async () => {
    expect(await listActivation({})).toMatchObject({ available: false, rows: [] });
    dir.v = Array.from({ length: 80 }, (_, i) => ({
      id: id(i + 1),
      slug: 's',
      name: 'n',
      status: 'active',
    }));
    expect((await listActivation({ limit: 500 }, bucket({}))).rows).toHaveLength(50);
  });

  it('funnel counts and medians only the stores that signed up in the range, and says when it truncated', async () => {
    dir.v = [1, 2, 3].map(n => ({ id: id(n), slug: 's', name: 'n', status: 'active' }));
    const out = await activationFunnel(
      { fromMs: SIGNUP - 1000, toMs: SIGNUP + 86_400_000 },
      bucket({
        [id(1)]: file(1, [60, 600]),
        [id(2)]: file(2, [60, 1800]),
        [id(3)]: { ...file(3, [60]), signupAt: SIGNUP - 90 * 86_400_000 },
      })
    );
    expect(out).toMatchObject({ available: true, stores: 2, truncated: false });
    expect(out.rows.find(r => r.step === 'payment_methods')).toMatchObject({
      count: 2,
      medianSecondsFromSignup: 1200,
    });
    dir.v = Array.from({ length: 600 + 1 }, (_, i) => ({
      id: id(i + 1),
      slug: 's',
      name: 'n',
      status: 'active',
    }));
    expect((await activationFunnel({ fromMs: 0, toMs: 1 }, bucket({}))).truncated).toBe(true);
  });
});
