import { beforeAll, describe, expect, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import { requirePlatformDb } from '../src/lib/platform-db';
import { applyAddonGrant } from '../src/services/billing/addon-grant';
import {
  claimAddonMarkerD1,
  claimBillingEventD1,
  setTermEndOnceD1,
} from '../src/services/platform/billing-d1';

// Follow-up to #775 (D1 review): on the platform D1 the prisma-lite `updateMany` / `createMany` are NOT atomic claims (SELECT
// then write per key), so the add-on grant must not count on them. These run the REAL grant against the REAL platform schema
// on workerd with every claim racing: one term per payment, and two payments of one add-on never overlap.
const e = env as unknown as { PLATFORM_DB: D1Database; TEST_PLATFORM_MIGRATIONS: unknown[] };
const NOW = new Date('2027-03-01T10:00:00.000Z');
const DAY = 86_400_000;
let seq = 0;
const uid = (l: string) => `${l}-${++seq}`;
const PLAN = 'addon:feature:floating_widget';

async function store() {
  const id = uid('store');
  await e.PLATFORM_DB.prepare(
    'INSERT INTO stores (id, name, slug, owner_id) VALUES (?1, ?1, ?1, ?2)'
  )
    .bind(id, uid('owner'))
    .run();
  return id;
}
async function paid(storeId: string, status = 'succeeded') {
  const id = uid('ev');
  await e.PLATFORM_DB.prepare(
    `INSERT INTO billing_events (id, store_id, type, plan_code, amount_minor, provider, idempotency_key, status)
     VALUES (?1, ?2, 'upgrade', ?3, 9900, 'kashier', ?4, ?5)`
  )
    .bind(id, storeId, PLAN, `k-${id}`, status)
    .run();
  return { id, storeId, planCode: PLAN };
}
const endOf = async (id: string) =>
  (
    (await e.PLATFORM_DB.prepare('SELECT for_period_end AS t FROM billing_events WHERE id = ?1')
      .bind(id)
      .first()) as { t: number | null }
  ).t;
const markers = async (storeId: string) =>
  (
    (await e.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS n FROM billing_events WHERE store_id = ?1 AND plan_code LIKE 'addon-grant:%'"
    )
      .bind(storeId)
      .first()) as { n: number }
  ).n;

describe('add-on grant on the platform D1: once per payment, never overlapping', () => {
  let tx: any;
  beforeAll(async () => {
    setCfBindings(e as unknown as CfBindings);
    await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
    const d1 = await requirePlatformDb();
    // store_features lives in the StoreDO, not on this D1: only the billing ledger is under test here.
    tx = { billingEvent: d1.billingEvent, storeFeature: { findFirst: async () => null } };
  });

  it('eight concurrent settles of ONE payment leave exactly one term and one marker', async () => {
    const s = await store();
    const row = await paid(s);
    const effects: unknown[] = [];
    await Promise.all(
      Array.from({ length: 8 }, () => applyAddonGrant(tx, row, NOW, effects as never))
    );
    expect(await endOf(row.id)).toBe(NOW.getTime() + 30 * DAY);
    expect(await markers(s)).toBe(1);
  });

  it('two DIFFERENT payments of one add-on racing do not overlap: the second starts where the first ends', async () => {
    const s = await store();
    const a = await paid(s);
    const b = await paid(s);
    await Promise.all([
      applyAddonGrant(tx, a, NOW, [] as never),
      applyAddonGrant(tx, b, NOW, [] as never),
    ]);
    const ends = [await endOf(a.id), await endOf(b.id)].sort();
    expect(ends).toEqual([NOW.getTime() + 30 * DAY, NOW.getTime() + 60 * DAY]);
    expect(await markers(s)).toBe(2);
  });

  it('a REPLAY of the first payment after the second was chained changes nothing (no stray marker, same end)', async () => {
    const s = await store();
    const a = await paid(s);
    await applyAddonGrant(tx, a, NOW, [] as never);
    const b = await paid(s);
    await applyAddonGrant(tx, b, NOW, [] as never);
    const before = [await endOf(a.id), await endOf(b.id), await markers(s)];
    await applyAddonGrant(tx, a, NOW, [] as never);
    expect([await endOf(a.id), await endOf(b.id), await markers(s)]).toEqual(before);
  });

  it('the term end is written ONCE: a second write with another end loses', async () => {
    const s = await store();
    const a = await paid(s);
    expect(await setTermEndOnceD1(a.id, s, NOW.getTime() + DAY)).toBe(true);
    expect(await setTermEndOnceD1(a.id, s, NOW.getTime() + 2 * DAY)).toBe(false);
    expect(await endOf(a.id)).toBe(NOW.getTime() + DAY);
  });

  it('buy, refund, re-buy: the refunded payment does not anchor the chain, access starts now with no gap and no free days', async () => {
    const s = await store();
    const a = await paid(s);
    await applyAddonGrant(tx, a, NOW, [] as never);
    await e.PLATFORM_DB.prepare("UPDATE billing_events SET status = 'refunded' WHERE id = ?1")
      .bind(a.id)
      .run();
    const mid = new Date(NOW.getTime() + 5 * DAY); // inside the refunded term's window
    const b = await paid(s);
    await applyAddonGrant(tx, b, mid, [] as never);
    expect(await endOf(b.id)).toBe(mid.getTime() + 30 * DAY); // from now, not from the refunded end
  });

  it('a payment whose settle is still in flight (status pending) still anchors: the next one chains after it, never overlaps', async () => {
    const s = await store();
    const a = await paid(s, 'pending'); // the D1 settle path flips the status AFTER the grant
    await applyAddonGrant(tx, a, NOW, [] as never);
    const b = await paid(s);
    await applyAddonGrant(tx, b, NOW, [] as never);
    expect(await endOf(b.id)).toBe(NOW.getTime() + 60 * DAY);
  });

  it('refunding the EARLIER of two chained terms leaves the later one in place and a new payment still stacks after it', async () => {
    const s = await store();
    const a = await paid(s);
    await applyAddonGrant(tx, a, NOW, [] as never);
    const b = await paid(s);
    await applyAddonGrant(tx, b, NOW, [] as never);
    await e.PLATFORM_DB.prepare("UPDATE billing_events SET status = 'refunded' WHERE id = ?1")
      .bind(a.id)
      .run();
    const c = await paid(s);
    await applyAddonGrant(tx, c, NOW, [] as never);
    expect(await endOf(b.id)).toBe(NOW.getTime() + 60 * DAY);
    expect(await endOf(c.id)).toBe(NOW.getTime() + 90 * DAY);
  });

  it('a later payment after the term expired starts from now, not from the old end', async () => {
    const s = await store();
    const a = await paid(s);
    await applyAddonGrant(tx, a, NOW, [] as never);
    const later = new Date(NOW.getTime() + 90 * DAY);
    const b = await paid(s);
    await applyAddonGrant(tx, b, later, [] as never);
    expect(await endOf(b.id)).toBe(later.getTime() + 30 * DAY);
  });
});

describe('renewal claim on the platform D1 (claimEvent = createMany + skipDuplicates)', () => {
  it('eight racing claims of one idempotency key: one row, and at most ONE caller sees count 1', async () => {
    const tx = await requirePlatformDb();
    const s = await store();
    const key = uid('addon-renew');
    const counts = await Promise.all(
      Array.from({ length: 8 }, () =>
        tx.billingEvent.createMany({
          data: [
            {
              id: crypto.randomUUID(),
              storeId: s,
              type: 'upgrade',
              planCode: PLAN,
              amountMinor: 9900,
              currency: 'EGP',
              provider: 'kashier',
              idempotencyKey: key,
              status: 'pending',
            },
          ],
          skipDuplicates: true,
        })
      )
    );
    const rows = (
      (await e.PLATFORM_DB.prepare(
        'SELECT COUNT(*) AS n FROM billing_events WHERE idempotency_key = ?1'
      )
        .bind(key)
        .first()) as { n: number }
    ).n;
    expect(rows).toBe(1);
    expect(counts.filter((c: { count: number }) => c.count === 1).length).toBeLessThanOrEqual(1);
  });
});

describe('the ledger claim on the platform D1 (claimBillingEventD1): exactly one winner, always', () => {
  it('eight racers on one idempotency key: exactly one true, one row, vat kept', async () => {
    const s = await store();
    const key = uid('claim');
    const row = (id: string) => ({
      id,
      storeId: s,
      subscriptionId: null,
      type: 'upgrade',
      planCode: PLAN,
      billingInterval: null,
      forPeriodEnd: null,
      attempt: 0,
      amountMinor: 11286,
      provider: 'kashier',
      idempotencyKey: key,
      relatedEventId: null,
      vatMinor: 1386,
      vat: { netMinor: 9900, vatMinor: 1386, rateBps: 1400 },
    });
    const won = await Promise.all(
      Array.from({ length: 8 }, () => claimBillingEventD1(row(crypto.randomUUID())))
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    const r = (await e.PLATFORM_DB.prepare(
      'SELECT COUNT(*) AS n, MAX(vat_minor) AS v, MAX(vat) AS vat, MAX(status) AS st FROM billing_events WHERE idempotency_key = ?1'
    )
      .bind(key)
      .first()) as { n: number; v: number; vat: string; st: string };
    expect(r.n).toBe(1);
    expect(r.v).toBe(1386);
    expect(JSON.parse(r.vat).netMinor).toBe(9900);
    expect(r.st).toBe('pending');
  });
});

describe('B3: the D1 claim keeps `raw` (a refund keepAccess) for the webhook settle', () => {
  it('raw is stored as JSON, and absent raw stays NULL', async () => {
    const s = await store();
    const mk = (raw?: unknown) => ({
      id: crypto.randomUUID(),
      storeId: s,
      subscriptionId: null,
      type: 'upgrade',
      planCode: PLAN,
      billingInterval: null,
      forPeriodEnd: null,
      attempt: 0,
      amountMinor: 9900,
      provider: 'kashier',
      idempotencyKey: uid('raw'),
      relatedEventId: null,
      vatMinor: 0,
      vat: null,
      raw,
    });
    const a = mk({ keepAccess: true });
    const b = mk();
    expect(await claimBillingEventD1(a)).toBe(true);
    expect(await claimBillingEventD1(b)).toBe(true);
    const rawOf = async (id: string) =>
      (
        (await e.PLATFORM_DB.prepare('SELECT raw FROM billing_events WHERE id = ?1')
          .bind(id)
          .first()) as {
          raw: string | null;
        }
      ).raw;
    expect(JSON.parse((await rawOf(a.id))!)).toEqual({ keepAccess: true });
    expect(await rawOf(b.id)).toBeNull();
  });
});

describe('D1 `meta.changes` counts the AFTER INSERT tax triggers: a claim wins on changes > 0, not === 1', () => {
  it('the marker claim: the first caller wins, the second is refused (no race needed)', async () => {
    const s = await store();
    const m = (relatedEventId: string) => ({
      id: crypto.randomUUID(),
      storeId: s,
      planCode: 'addon-grant:feature:floating_widget',
      relatedEventId,
      endMs: NOW.getTime() + 30 * DAY,
      key: `k-${s}`,
    });
    expect(await claimAddonMarkerD1(m('a'))).toBe(true);
    expect(await claimAddonMarkerD1(m('b'))).toBe(false);
  });
});
