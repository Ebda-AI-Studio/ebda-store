import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
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

  it('a closed store answers STORE_CLOSED with status 410, never a status-less answer (Ruling NZ-D20)', async () => {
    const stub = stubFor('mut-closed');
    expect(await stub.closeIfNoMoneyInFlight('mut-closed')).toMatchObject({ ok: true });
    expect(
      await stub.mutate('mut-closed', {
        ops: [{ model: 'StorePage', op: 'create', args: page('mut-closed', 'x') }],
      })
    ).toMatchObject({ ok: false, code: 'STORE_CLOSED', status: 410 });
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

describe('StoreDO.mutate procedures and the settings copy (PR D1b)', () => {
  it('mergeAiFieldSources runs on real workerd SQLite (json_patch / json_remove) inside the batch', async () => {
    const c = clientFor('mut-proc');
    const p = await c.product.create({
      data: {
        storeId: 'mut-proc',
        name: 'P',
        slug: 'p',
        price: 1,
        aiFieldSources: { a: 'ai', b: 'ai' },
      },
    });
    const [merged] = await c.$transaction([
      c.$proc('mergeAiFieldSources', {
        productId: p.id,
        set: { a: 'human', c: 'ai' },
        remove: ['b'],
      }),
    ]);
    expect(merged).toEqual({ a: 'human', c: 'ai' });
    expect((await c.product.findFirst({ where: { id: p.id } })).aiFieldSources).toEqual({
      a: 'human',
      c: 'ai',
    });
  });

  it('applySettings writes the profile/config copy, reports D1-only fields, refuses unknown fields and another store', async () => {
    const stub = stubFor('mut-set');
    await stub.mutate('mut-set', { ops: [{ model: 'StorePage', op: 'count' }] }); // binds the instance
    await runInDurableObject(stub, async d => {
      d.ctx.storage.sql.exec(
        "INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('mut-set', 'S', 's', 'u')"
      );
    });
    const { encodeRpc } = await import('@ebda-src/repo');
    const ok = await stub.applySettings(
      'mut-set',
      encodeRpc({
        heroTitle: 'Hello',
        theme: { primary: '#B08D57' },
        blogEnabled: true,
        domainStatus: 'active',
      })
    );
    expect(ok).toMatchObject({ ok: true, data: { directoryOnly: ['domainStatus'] } });
    const row = await runInDurableObject(stub, async d => ({
      p: d.ctx.storage.sql
        .exec("SELECT hero_title, theme FROM store_profile WHERE store_id = 'mut-set'")
        .one(),
      c: d.ctx.storage.sql
        .exec("SELECT blog_enabled FROM store_config WHERE store_id = 'mut-set'")
        .one(),
    }));
    expect([row.p.hero_title, JSON.parse(row.p.theme as string), row.c.blog_enabled]).toEqual([
      'Hello',
      { primary: '#B08D57' },
      1,
    ]);
    expect(await stub.applySettings('mut-set', encodeRpc({ nope: 1 }))).toMatchObject({
      ok: false,
    });
    expect(await stub.applySettings('someone-else', encodeRpc({ heroTitle: 'x' }))).toMatchObject({
      ok: false,
      code: 'STORE_MISMATCH',
    });
  });
  it('patchSettings (BE:F-2/F-3) merges only the sent keys in ONE DO transaction and rolls a refused part back', async () => {
    const stub = stubFor('mut-patch');
    await stub.mutate('mut-patch', { ops: [{ model: 'StorePage', op: 'count' }] }); // binds the instance
    await runInDurableObject(stub, async d => {
      d.ctx.storage.sql.exec(
        "INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('mut-patch', 'S', 's', 'u')"
      );
    });
    const { encodeRpc } = await import('@ebda-src/repo');
    await stub.applySettings('mut-patch', encodeRpc({ settings: { base: 1 } }));
    const [a, b] = await Promise.all([
      stub.patchSettings('mut-patch', encodeRpc({ json: { settings: { set: { a: 1 } } } })),
      stub.patchSettings('mut-patch', encodeRpc({ json: { settings: { set: { b: 2 } } } })),
    ]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    const settings = () =>
      runInDurableObject(stub, async d =>
        JSON.parse(
          d.ctx.storage.sql
            .exec("SELECT settings FROM store_config WHERE store_id = 'mut-patch'")
            .one().settings as string
        )
      );
    expect(await settings()).toEqual({ base: 1, a: 1, b: 2 });
    // a refused part (unknown field) leaves the settings of the same patch unwritten
    expect(
      await stub.patchSettings(
        'mut-patch',
        encodeRpc({ fields: { nope: 1 }, json: { settings: { set: { c: 3 } } } })
      )
    ).toMatchObject({ ok: false });
    expect(await settings()).toEqual({ base: 1, a: 1, b: 2 });
  });
  it('bootstrapStore (N-18) creates profile + config + inactive VAT + COD, is idempotent, and the record reads back', async () => {
    const stub = stubFor('boot-1');
    const { encodeRpc, decodeRpc: dec } = await import('@ebda-src/repo');
    const input = encodeRpc({
      identity: { name: 'Boot', slug: 'boot', ownerId: 'owner-1' },
      fields: {
        name: 'Boot',
        slug: 'boot',
        ownerId: 'owner-1',
        status: 'inactive',
        plan: 'professional',
        settings: { currency: 'EGP' },
        theme: { frameChromeDedup: true },
        layoutSettings: {},
        domainStatus: 'active',
      },
      vat: { id: 'vat-1', name: 'VAT', nameAr: 'ضريبة', rate: 1400 },
      cod: { id: 'cod-1', name: 'Cash on Delivery', nameAr: 'الدفع', currency: 'EGP' },
    });
    expect(await stub.bootstrapStore('boot-1', input)).toMatchObject({
      ok: true,
      data: { directoryOnly: ['domainStatus'] },
    });
    // a retry converges: still one VAT row and one COD row
    expect(await stub.bootstrapStore('boot-1', input)).toMatchObject({ ok: true });
    const rows = await runInDurableObject(stub, async d => ({
      vat: d.ctx.storage.sql
        .exec("SELECT rate, is_active FROM tax_rates WHERE store_id = 'boot-1'")
        .toArray(),
      cod: d.ctx.storage.sql
        .exec("SELECT is_enabled, provider FROM payment_configs WHERE store_id = 'boot-1'")
        .toArray(),
    }));
    expect(rows.vat).toEqual([{ rate: 1400, is_active: 0 }]);
    expect(rows.cod).toEqual([{ is_enabled: 1, provider: 'cod' }]);
    const rec = await stub.storeRecord('boot-1', ['name', 'plan', 'status', 'settings']);
    expect(rec).toMatchObject({ ok: true });
    expect(dec((rec as { data: { json: string } }).data.json)).toMatchObject({
      name: 'Boot',
      plan: 'professional',
      status: 'inactive',
      settings: { currency: 'EGP' },
    });
    expect(await stub.bootstrapStore('someone-else', input)).toMatchObject({
      ok: false,
      code: 'STORE_MISMATCH',
    });
  });
  it('applySettings ignores a copy OLDER than the one the DO holds (out-of-order whole-value copies)', async () => {
    const stub = stubFor('ord-1');
    await stub.mutate('ord-1', { ops: [{ model: 'StorePage', op: 'count' }] });
    await runInDurableObject(stub, async d => {
      d.ctx.storage.sql.exec(
        "INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('ord-1', 'S', 's', 'u')"
      );
    });
    const { encodeRpc } = await import('@ebda-src/repo');
    const newer = new Date(Date.now() + 60_000);
    const older = new Date(Date.now() + 30_000);
    await stub.applySettings('ord-1', encodeRpc({ heroTitle: 'new', updatedAt: newer }));
    await stub.applySettings('ord-1', encodeRpc({ heroTitle: 'old', updatedAt: older }));
    const row = await runInDurableObject(stub, async d =>
      d.ctx.storage.sql
        .exec("SELECT hero_title, updated_at FROM store_profile WHERE store_id = 'ord-1'")
        .one()
    );
    expect(row).toEqual({ hero_title: 'new', updated_at: newer.getTime() });
  });
});
