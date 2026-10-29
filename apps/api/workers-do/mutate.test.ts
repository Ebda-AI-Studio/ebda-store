import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createDoClient, decodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR D1 (Ruling CF-WRITES-1): the StoreDO `mutate` RPC on real workerd: one atomic transaction per call,
// replay-safe with a key, allow-listed models only, bound to ONE store. The same client the API Worker builds drives it.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
const clientFor = (storeId: string) => {
  const stub = stubFor(storeId);
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};
const page = (storeId: string, slug: string) => ({
  data: { storeId, slug, title: slug, isPublished: true },
});

describe('StoreDO.mutate', () => {
  it('writes through the real client, reads them back, and a unique violation is a P2002 with nothing half-applied', async () => {
    const c = clientFor('mut-a');
    const made = await c.blogPost.create({
      data: { storeId: 'mut-a', slug: 'hello', title: 'Hello', content: 'Body' },
    });
    expect(made).toMatchObject({ slug: 'hello', title: 'Hello' });
    expect(
      (await c.blogPost.findMany({ where: { storeId: 'mut-a' } })).map((p: any) => p.slug)
    ).toEqual(['hello']);
    await expect(
      c.$transaction([
        c.storePage.create(page('mut-a', 'x')),
        c.storePage.create(page('mut-a', 'x')),
      ])
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await c.storePage.count()).toBe(0); // the first create of the failed batch was rolled back
  });

  it('an idempotency key replays the first result and does not write twice', async () => {
    const c = clientFor('mut-key');
    const run = () =>
      c.$transaction([c.storePage.create(page('mut-key', 'once'))], {
        idempotencyKey: 'key-0000-0001',
      });
    const [first] = await run();
    const [second] = await run();
    expect(second.id).toBe(first.id);
    expect(await c.storePage.count()).toBe(1);
    // the same key for a different batch is refused, not silently replayed
    await expect(
      c.$transaction([c.storePage.create(page('mut-key', 'other'))], {
        idempotencyKey: 'key-0000-0001',
      })
    ).rejects.toThrow(/another batch/);
  });

  it('refuses money models and stock writes as an answer (nothing is written)', async () => {
    const stub = stubFor('mut-refuse');
    expect(
      await stub.mutate('mut-refuse', {
        ops: [{ model: 'Order', op: 'create', args: { data: {} } }],
      })
    ).toMatchObject({ ok: false, code: 'MODEL_NOT_WRITABLE' });
    expect(
      await stub.mutate('mut-refuse', {
        ops: [{ model: 'Product', op: 'updateMany', args: { where: {}, data: { inventory: 1 } } }],
      })
    ).toMatchObject({ ok: false, code: 'STOCK_WRITE_REFUSED' });
  });

  it("is bound to one store: another store's id is refused, and a row carrying it never lands", async () => {
    const a = stubFor('mut-iso-a');
    await a.mutate('mut-iso-a', {
      ops: [{ model: 'StorePage', op: 'create', args: page('mut-iso-a', 'p') }],
    });
    expect(
      await a.mutate('mut-iso-b', {
        ops: [{ model: 'StorePage', op: 'create', args: page('mut-iso-b', 'leak') }],
      })
    ).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
    const wrongRow = await a.mutate('mut-iso-a', {
      ops: [{ model: 'StorePage', op: 'create', args: page('mut-iso-b', 'leak2') }],
    });
    expect(wrongRow.ok).toBe(false);
    const rows = await a.query('mut-iso-a', [{ model: 'StorePage', op: 'findMany' }]);
    expect(rows.ok && decodeRpc<any[][]>(rows.json)[0].map(r => r.slug)).toEqual(['p']);
  });
});
