import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_MS, MAX_STALE_MS, SNAPSHOT_KEY, getSnapshot } from '../src/snapshot-cache';
import type { Snapshot } from '../src/types';

const snap = (at: number): Snapshot => ({
  generatedAt: at,
  overall: 'operational',
  components: [],
  active: [],
  recent: [],
});
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  await caches.default.delete(SNAPSHOT_KEY);
});

describe('status snapshot cache (BOUNDED-stale)', () => {
  it('first read loads from the store, the next reads never touch it', async () => {
    const load = vi.fn(async () => snap(NOW));
    await getSnapshot(load, undefined, NOW);
    await getSnapshot(load, undefined, NOW + 1000);
    await getSnapshot(load, undefined, NOW + FRESH_MS);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a stale snapshot is served at once while ONE background refresh runs', async () => {
    await getSnapshot(async () => snap(NOW), undefined, NOW);
    let release!: (s: Snapshot) => void;
    const slow = vi.fn(() => new Promise<Snapshot>(r => (release = r)));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    const t = NOW + FRESH_MS + 1;
    const a = await getSnapshot(slow, ctx, t); // returns while the refresh is still pending
    const b = await getSnapshot(slow, ctx, t);
    expect(a.generatedAt).toBe(NOW);
    expect(b.generatedAt).toBe(NOW);
    expect(slow).toHaveBeenCalledTimes(1);
    release(snap(t));
    await Promise.all(waits);
    const c = await getSnapshot(slow, ctx, t + 1);
    expect(c.generatedAt).toBe(t);
  });

  it('past the stale window it waits for a live read', async () => {
    await getSnapshot(async () => snap(NOW), undefined, NOW);
    const t = NOW + MAX_STALE_MS + 1;
    const got = await getSnapshot(async () => snap(t), undefined, t);
    expect(got.generatedAt).toBe(t);
  });

  it('serves the old snapshot rather than failing when the store throws', async () => {
    await getSnapshot(async () => snap(NOW), undefined, NOW);
    const t = NOW + MAX_STALE_MS + 1;
    const got = await getSnapshot(
      async () => {
        throw new Error('do down');
      },
      undefined,
      t
    );
    expect(got.generatedAt).toBe(NOW);
  });

  it('with nothing cached and the store down it throws', async () => {
    await expect(
      getSnapshot(
        async () => {
          throw new Error('do down');
        },
        undefined,
        NOW
      )
    ).rejects.toThrow('do down');
  });
});
