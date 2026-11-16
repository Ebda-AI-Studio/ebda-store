import { describe, expect, it, vi } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import { createDoClient } from '@ebda-src/repo';

vi.mock('../src/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));

import '../src/lib/store-scope-resolver'; // as app.ts: acrossStores reads the D1 directory
import { abandonedCartPurge } from '../src/lib/inngest/functions/data-retention';
import { prismaCiSource } from '../src/lib/ci/source';
import { configureIdentityClient } from '../src/lib/identity-client';

// P3 (#15, abandoned-cart retention = 30 days) and VS-9 (customer-intelligence reads on a DO store, not Postgres) on real
// workerd: a real StoreDO per store behind the real D1 directory (`stores.storage_backend = 'do'`), the REAL job handler and the
// REAL CI source. Postgres does not exist in this lane, so any read that still reached `prisma` would throw instead of answering.
const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0b000000-0000-4000-8000-00000000000b';
const CI = '0c000000-0000-4000-8000-00000000000c';

const clientFor = (storeId: string) => {
  const stub = e.STORE_DO.get(e.STORE_DO.idFromName(storeId));
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};

const insertStore = (id: string, owner: string, ciSharing = 0) =>
  e.PLATFORM_DB.prepare(
    "INSERT INTO stores (id, name, slug, owner_id, storage_backend, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'do', ?5, ?5)"
  )
    .bind(id, `Name ${id}`, `slug-${id}`, owner, T0)
    .run()
    .then(() => ciSharing);

async function cart(storeId: string, tag: string, ageDays: number, customerId: string | null) {
  const c = clientFor(storeId);
  const ct = await c.cart.create({ data: { storeId, sessionId: `s-${tag}` } });
  return c.abandonedCart.create({
    data: {
      storeId,
      cartId: ct.id,
      sessionId: `s-${tag}`,
      customerId,
      customerEmail: `${tag}@example.test`,
      cartTotal: 1000,
      cartItemCount: 1,
      cartItems: [],
      status: 'pending',
      createdAt: new Date(Date.now() - ageDays * DAY),
    },
  });
}
const idsLeft = async (storeId: string) =>
  (await clientFor(storeId).abandonedCart.findMany({ where: { storeId }, select: { id: true } }))
    .map((r: { id: string }) => r.id)
    .sort();

const runPurge = (data: Record<string, unknown> = {}) =>
  abandonedCartPurge.handler({
    event: { name: 'cron', data },
    step: {
      run: async (_id: string, fn: () => unknown) => fn(),
      sleep: async () => undefined,
      sleepUntil: async () => undefined,
      sendEvent: async () => undefined,
    },
    runId: 'test',
    attempt: 0,
  } as never) as Promise<{ purged: number }>;

describe('P3: abandoned-cart retention (30 days) on the store Durable Object', () => {
  it('setup: platform D1 directory with two DO stores', async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    await insertStore(A, 'owner-a');
    await insertStore(B, 'owner-b');
    await insertStore(CI, 'owner-ci');
  });

  it('purges anonymous carts older than 30 days in EVERY store; keeps newer ones and logged-in customers carts', async () => {
    const oldA = await cart(A, 'old-a', 31, null);
    const edgeA = await cart(A, 'recent-a', 29, null); // inside the window
    const ownedA = await cart(A, 'owned-a', 90, 'cust-1'); // old, but a logged-in customer is attached: not this job's rows
    const oldB = await cart(B, 'old-b', 45, null);
    const newB = await cart(B, 'new-b', 1, null);

    const r = await runPurge();

    expect(r.purged).toBe(2);
    expect(await idsLeft(A)).toEqual([edgeA.id, ownedA.id].sort());
    expect(await idsLeft(B)).toEqual([newB.id]);
    expect(await idsLeft(A)).not.toContain(oldA.id);
    expect(await idsLeft(B)).not.toContain(oldB.id);
  });

  it('a second run finds nothing (idempotent) and the per-store alarm run touches only its own store', async () => {
    expect((await runPurge()).purged).toBe(0);
    const oldA = await cart(A, 'old-a2', 40, null);
    const oldB = await cart(B, 'old-b2', 40, null);
    const r = await runPurge({ alarm: true, storeId: B });
    expect(r.purged).toBe(1);
    expect(await idsLeft(A)).toContain(oldA.id); // store A was not on this alarm
    expect(await idsLeft(B)).not.toContain(oldB.id);
  });
});

describe('VS-9: customer-intelligence reads a DO store without touching Postgres', () => {
  const ORDER = 'ci-order-1';
  it('storeSetup / storeCiSharing / priorOrdersByBuyer / abandonedCart / hasWhatsAppCodOutcome / order / shipment all answer on the DO', async () => {
    const c = clientFor(CI);
    const ac = await cart(CI, 'ci-cart', 1, null);
    // The owner's signup instant comes from the identity service; a fake binding answers with no account.
    configureIdentityClient({ getAccountsBrief: async () => [] } as never);
    // storeSetup reads the store's own profile row inside the DO (the D1 directory row alone is not enough).
    await runInDurableObject(e.STORE_DO.get(e.STORE_DO.idFromName(CI)), (_i, st) => {
      st.storage.sql.exec('PRAGMA foreign_keys = OFF');
      st.storage.sql.exec(
        "INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner-ci')",
        CI,
        CI
      );
    });

    // No column is set: the point is that the read answers (a boolean, the default) instead of throwing POSTGRES_REMOVED.
    await expect(prismaCiSource.storeCiSharing(CI)).resolves.toBe(false);
    const setup = await prismaCiSource.storeSetup(CI);
    expect(setup).not.toBeNull();
    expect(setup!.ciSharing).toBe(false);

    await expect(
      prismaCiSource.priorOrdersByBuyer(CI, 'bk'.padEnd(64, '1'), new Date(), ORDER)
    ).resolves.toBe(0);
    await expect(prismaCiSource.hasWhatsAppCodOutcome(CI, ORDER)).resolves.toBe(false);
    await expect(prismaCiSource.order(CI, 'no-such-order')).resolves.toBeNull();
    await expect(prismaCiSource.shipment(CI, 'no-such-shipment')).resolves.toBeNull();

    const facts = await prismaCiSource.abandonedCart(CI, ac.id);
    expect(facts).toMatchObject({
      id: ac.id,
      firstReminderAt: null,
      firstChannel: null,
      recoveredAt: null,
    });
    await c.abandonedCart.update({
      where: { id: ac.id, storeId: CI },
      data: { emailSentAt: new Date(T0) },
    });
    expect(await prismaCiSource.abandonedCart(CI, ac.id)).toMatchObject({ firstChannel: 'email' });
  });
});
