/**
 * Merchant outgoing webhooks on the real strict-RLS role `ebda_app` + the code-level tenant guard:
 * fan-out reaches only the event's own store, the 50-row log cap, dedupe under replay, no
 * cross-tenant read/write, and the store-delete cascade. Owner-role `prisma` is used only for
 * fixtures and read-backs. Every fixture is per CALL (retry-safe). NOT RUN in the authoring session
 * (no database slot): run with a migrated Postgres once available.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { prisma, createPrismaClient, runWithRequestDb, runInTenantContext } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { fanoutWebhookEvent } from '../../apps/api/src/services/webhook.service';
import { redactWebhookCustomerData } from '../../apps/api/src/services/webhook-erasure';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);

const created = { storeIds: [] as string[], userIds: [] as string[] };
const uid = () => crypto.randomUUID().slice(0, 12);

async function seedStore(tag: string): Promise<string> {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `wh-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'W',
      lastName: 'H',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `wh ${tag} ${id}`,
      slug: `wh-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  return store.id;
}
const endpoint = (storeId: string, events = ['order.created']) =>
  prisma.webhookEndpoint.create({
    data: {
      storeId,
      url: 'https://hooks.example.com/x',
      events,
      secretEnc: 'enc',
      secretHint: 'abcd',
    },
  });
const ev = (key: string) => ({
  type: 'order.created',
  dedupeKey: key,
  data: { order: { id: 'o1' } },
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.webhookDelivery.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.webhookEndpoint.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('merchant webhooks on ebda_app (guard + strict RLS)', () => {
  it('fans out to the event store only and is idempotent per dedupe key', async () => {
    const a = await seedStore('a');
    const b = await seedStore('b');
    const ea = await endpoint(a);
    await endpoint(b);
    const first = await asApp(() => runInTenantContext(a, () => fanoutWebhookEvent(a, ev('k1'))));
    const replay = await asApp(() => runInTenantContext(a, () => fanoutWebhookEvent(a, ev('k1'))));
    expect(first).toHaveLength(1);
    expect(replay).toEqual([]);
    expect(await prisma.webhookDelivery.count({ where: { storeId: a, endpointId: ea.id } })).toBe(
      1
    );
    expect(await prisma.webhookDelivery.count({ where: { storeId: b } })).toBe(0);
  });

  it('C1: replaying two events after a second endpoint appears creates its rows and never aborts the transaction', async () => {
    const s = await seedStore('c1');
    await endpoint(s, ['order.created', 'order.paid']);
    const paid = { ...ev('p1'), type: 'order.paid' };
    const run = (e: ReturnType<typeof ev>) =>
      asApp(() => runInTenantContext(s, () => fanoutWebhookEvent(s, e)));
    await run(ev('c1'));
    await run(paid);
    await endpoint(s, ['order.created', 'order.paid']);
    expect(await run(ev('c1'))).toHaveLength(1);
    expect(await run(paid)).toHaveLength(1);
    expect(await prisma.webhookDelivery.count({ where: { storeId: s } })).toBe(4);
  });

  it("store B's context sees none of store A's endpoints or deliveries, and cannot write into A", async () => {
    const a = await seedStore('iso-a');
    const b = await seedStore('iso-b');
    const ea = await endpoint(a);
    await asApp(() => runInTenantContext(a, () => fanoutWebhookEvent(a, ev('k'))));
    const seen = await asApp(() =>
      runInTenantContext(b, async () => ({
        endpoints: await prisma.webhookEndpoint.findMany({ where: { storeId: b } }),
        crossEndpoints: await prisma.webhookEndpoint
          .findMany({ where: { storeId: a } })
          .catch(() => 'refused'),
      }))
    );
    expect(seen.endpoints).toEqual([]);
    expect(
      seen.crossEndpoints === 'refused' || (seen.crossEndpoints as unknown[]).length === 0
    ).toBe(true);
    await expect(
      asApp(() =>
        runInTenantContext(b, () =>
          prisma.webhookDelivery.create({
            data: {
              storeId: a,
              endpointId: ea.id,
              eventId: 'evt_x',
              eventType: 'order.created',
              payload: {},
            },
          })
        )
      )
    ).rejects.toThrow();
  });

  it('M10: erasure strips data.customer from this store only, keeps the order record', async () => {
    const a = await seedStore('er-a');
    const b = await seedStore('er-b');
    for (const s of [a, b]) {
      await prisma.webhookEndpoint.create({
        data: {
          storeId: s,
          url: 'https://hooks.example.com/x',
          events: ['order.created'],
          includeCustomer: true,
          secretEnc: 'enc',
          secretHint: 'abcd',
        },
      });
      await asApp(() =>
        runInTenantContext(s, () =>
          fanoutWebhookEvent(s, {
            type: 'order.created',
            dedupeKey: 'k',
            data: { order: { id: 'o-shared' } },
            customer: { name: 'A', email: 'a@x.co', phone: '1' },
          })
        )
      );
    }
    await asApp(() =>
      runInTenantContext(a, () =>
        redactWebhookCustomerData(prisma, { storeId: a, orderIds: ['o-shared'], email: 'a@x.co' })
      )
    );
    const rowA = await prisma.webhookDelivery.findFirst({ where: { storeId: a } });
    const rowB = await prisma.webhookDelivery.findFirst({ where: { storeId: b } });
    expect((rowA!.payload as any).data.customer).toBeUndefined();
    expect((rowA!.payload as any).data.order.id).toBe('o-shared');
    expect((rowB!.payload as any).data.customer).toEqual({
      name: 'A',
      email: 'a@x.co',
      phone: '1',
    });
  });

  it('keeps only the last 50 deliveries per endpoint', async () => {
    const s = await seedStore('cap');
    await endpoint(s);
    for (let i = 0; i < 52; i++) {
      await asApp(() => runInTenantContext(s, () => fanoutWebhookEvent(s, ev(`k${i}`))));
    }
    expect(await prisma.webhookDelivery.count({ where: { storeId: s } })).toBe(50);
  });

  it('deleting the store cascades endpoints and deliveries', async () => {
    const s = await seedStore('cascade');
    await endpoint(s);
    await asApp(() => runInTenantContext(s, () => fanoutWebhookEvent(s, ev('k'))));
    await prisma.store.delete({ where: { id: s } });
    created.storeIds = created.storeIds.filter(x => x !== s);
    expect(await prisma.webhookEndpoint.count({ where: { storeId: s } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { storeId: s } })).toBe(0);
  });
});
