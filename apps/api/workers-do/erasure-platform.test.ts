import { describe, expect, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  exportPlatformSubject,
  erasePlatformSubject,
  countPlatformSubject,
  eraseStorePlatformData,
} from '../src/cf/erasure/platform-subject';
import { paymentsSurface, type PaymentsErasurePort } from '../src/cf/erasure/surfaces';
import type { MerchantSubject, CustomerSubject } from '../src/cf/erasure';

// SC-G10 (PDPL erasure / export), the surfaces erasure.test.ts does not touch: the PLATFORM D1 (memberships, API keys, invites,
// actor ids on rows that outlive the user), the store-deleted platform rows, and the platform-payments port. Real D1 with the REAL
// platform migrations; the classification JSON drives the engine exactly as in production.
const e = env as unknown as { PLATFORM_DB: D1Database; TEST_PLATFORM_MIGRATIONS: unknown[] };
const db = () => e.PLATFORM_DB;
const T = 1_700_000_000_000;
const run = (sql: string, ...b: unknown[]) =>
  db()
    .prepare(sql)
    .bind(...b)
    .run();
const all = async (sql: string, ...b: unknown[]) =>
  (
    await db()
      .prepare(sql)
      .bind(...b)
      .all()
  ).results as Array<Record<string, any>>;

async function seed() {
  await run(
    "INSERT INTO plans (id, code, name_en, name_ar, limits) VALUES ('plan-pro', 'pro', 'Pro', 'Pro', '{}')"
  );
  for (const s of ['pf-a', 'pf-b'])
    await run(
      'INSERT INTO stores (id, name, slug, owner_id, created_at, updated_at) VALUES (?1, ?1, ?1, ?2, ?3, ?3)',
      s,
      'owner',
      T
    );
  // u-victim: a staff member of both stores, with an API key, and the actor on surviving rows. u-other: untouched control.
  for (const [id, store, user] of [
    ['ss1', 'pf-a', 'u-victim'],
    ['ss2', 'pf-b', 'u-victim'],
    ['ss3', 'pf-a', 'u-other'],
  ])
    await run(
      'INSERT INTO store_staff (id, store_id, user_id) VALUES (?1, ?2, ?3)',
      id,
      store,
      user
    );
  for (const [id, store, user] of [
    ['k1', 'pf-a', 'u-victim'],
    ['k2', 'pf-a', 'u-other'],
  ])
    await run(
      "INSERT INTO merchant_api_keys (id, store_id, user_id, name, key_hash, prefix, scopes) VALUES (?1, ?2, ?3, 'n', 'SECRET-HASH-' || ?1, 'pk_', '[]')",
      id,
      store,
      user
    );
  await run(
    "INSERT INTO staff_invites (id, store_id, email, status, invited_by, expires_at) VALUES ('i1', 'pf-a', 'Victim@Example.com', 'pending', 'u-other', ?1)",
    T + 1e9
  );
  await run(
    "INSERT INTO staff_invites (id, store_id, email, status, invited_by, accepted_by, expires_at) VALUES ('i2', 'pf-a', 'someone@example.com', 'accepted', 'u-victim', 'u-victim', ?1)",
    T + 1e9
  );
  await run(
    "INSERT INTO platform_audit_log (id, actor_id, action, meta) VALUES ('a1', 'u-victim', 'x', '{}'), ('a2', 'u-other', 'x', '{}')"
  );
  await run(
    "INSERT INTO store_features (id, store_id, feature_key, enabled, enabled_by) VALUES ('f1', 'pf-a', 'k', 1, 'u-victim')"
  );
  await run(
    "INSERT INTO legal_acceptances (id, user_id, doc_key, version, source) VALUES ('l1', 'u-victim', 'terms', '1', 'signup'), ('l2', 'u-other', 'terms', '1', 'signup')"
  );
  await run(
    "INSERT INTO store_subscriptions (id, store_id, plan_code, provider_customer_id, payment_method_last4) VALUES ('sub1', 'pf-a', 'pro', 'cus_123', '4242')"
  );
}

const VICTIM = { userId: 'u-victim', email: 'victim@example.com' };

describe('platform D1 subject export + erasure (Ruling FOLD-ERASURE-1)', () => {
  it('setup', async () => {
    await applyD1Migrations(db(), e.TEST_PLATFORM_MIGRATIONS as never);
    await seed();
  });

  it('EXPORT returns the subject rows on every surface, matches the invite by e-mail case-insensitively, and never exports a credential hash or another person', async () => {
    const out = await exportPlatformSubject(db(), VICTIM);
    expect(out.store_staff.map(r => r.id).sort()).toEqual(['ss1', 'ss2']);
    expect(out.merchant_api_keys.map(r => r.id)).toEqual(['k1']);
    expect(out.merchant_api_keys[0]).not.toHaveProperty('key_hash');
    expect(out.legal_acceptances.map(r => r.id)).toEqual(['l1']);
    expect(out['platform_audit_log(actor)'].map(r => r.actor_id)).toEqual(['u-victim']);
    expect(out['store_features(actor)']).toHaveLength(1);
    expect(out['staff_invites(actor)'].map(r => r.row_ref).length).toBe(1); // i2 (invited_by/accepted_by = victim)
    expect(out.staff_invites.map(r => r.id)).toEqual(['i1']); // by address, case-insensitive
    expect(JSON.stringify(out)).not.toContain('SECRET-HASH');
    expect(JSON.stringify(out)).not.toContain('u-other');
  });

  it('ERASE deletes the person rows, replaces the actor id on rows that must survive, revokes + anonymises the invite, leaves the control user alone, and reads back 0', async () => {
    expect(await countPlatformSubject(db(), VICTIM)).toBeGreaterThan(0);
    const r = await erasePlatformSubject(db(), VICTIM, T);
    expect(r.changed).toBeGreaterThan(0);
    expect(await countPlatformSubject(db(), VICTIM)).toBe(0);

    expect(await all("SELECT id FROM store_staff WHERE user_id = 'u-victim'")).toEqual([]);
    expect(await all("SELECT id FROM merchant_api_keys WHERE user_id = 'u-victim'")).toEqual([]);
    expect(await all("SELECT id FROM legal_acceptances WHERE user_id = 'u-victim'")).toEqual([]);
    // surviving rows keep existing but no longer name the user
    const audit = await all('SELECT id, actor_id FROM platform_audit_log ORDER BY id');
    expect(audit).toEqual([
      { id: 'a1', actor_id: null },
      { id: 'a2', actor_id: 'u-other' },
    ]);
    expect(
      (await all("SELECT enabled_by FROM store_features WHERE id = 'f1'"))[0].enabled_by
    ).toBeNull();
    const i1 = (
      await all("SELECT email, status, decided_at FROM staff_invites WHERE id = 'i1'")
    )[0];
    expect(i1).toMatchObject({ status: 'revoked', decided_at: T });
    expect(i1.email).toBe('erased-i1@anonymized.invalid');
    const i2 = (
      await all("SELECT invited_by, accepted_by, status FROM staff_invites WHERE id = 'i2'")
    )[0];
    expect(i2).toEqual({ invited_by: null, accepted_by: null, status: 'accepted' });
    // the control user is untouched
    expect((await all("SELECT id FROM store_staff WHERE user_id = 'u-other'")).length).toBe(1);
    expect((await all("SELECT id FROM merchant_api_keys WHERE user_id = 'u-other'")).length).toBe(
      1
    );
    expect((await all("SELECT id FROM legal_acceptances WHERE user_id = 'u-other'")).length).toBe(
      1
    );
    // and a repeat is a harmless no-op
    expect((await erasePlatformSubject(db(), VICTIM, T)).changed).toBe(0);
  });
});

describe('store deletion: store-scoped platform rows (Ruling FOLD-ERASURE-2)', () => {
  it('removes staff + API keys, revokes + anonymises invites, strips the card reference but KEEPS the billing record; another store is untouched', async () => {
    await run(
      "INSERT INTO store_subscriptions (id, store_id, plan_code, provider_customer_id, payment_method_last4) VALUES ('sub2', 'pf-b', 'pro', 'cus_b', '1111')"
    );
    await run(
      "INSERT INTO staff_invites (id, store_id, email, status, expires_at) VALUES ('ib', 'pf-b', 'b@example.com', 'pending', ?1)",
      T + 1e9
    );
    await run("INSERT INTO store_staff (id, store_id, user_id) VALUES ('ssb', 'pf-b', 'u-b')");
    await eraseStorePlatformData(db(), 'pf-a', T);

    expect(await all("SELECT id FROM store_staff WHERE store_id = 'pf-a'")).toEqual([]);
    expect(await all("SELECT id FROM merchant_api_keys WHERE store_id = 'pf-a'")).toEqual([]);
    const inv = await all(
      "SELECT email, status FROM staff_invites WHERE store_id = 'pf-a' ORDER BY id"
    );
    expect(inv.every(r => r.email.startsWith('erased-'))).toBe(true);
    const sub = (
      await all(
        "SELECT plan_code, provider_customer_id, payment_method_last4 FROM store_subscriptions WHERE id = 'sub1'"
      )
    )[0];
    expect(sub).toEqual({
      plan_code: 'pro',
      provider_customer_id: null,
      payment_method_last4: null,
    });
    // store B is a different tenant
    expect((await all("SELECT id FROM store_staff WHERE store_id = 'pf-b'")).length).toBe(1);
    expect(
      (await all("SELECT provider_customer_id FROM store_subscriptions WHERE id = 'sub2'"))[0]
        .provider_customer_id
    ).toBe('cus_b');
    expect((await all("SELECT email FROM staff_invites WHERE id = 'ib'"))[0].email).toBe(
      'b@example.com'
    );
  });
});

describe('platform-payments surface (N-27)', () => {
  const calls: Array<[string, string[]]> = [];
  const port: PaymentsErasurePort = {
    scrub: async (ids, req) => (calls.push(['scrub', [...ids, req]]), { erased: ids.length * 2 }),
    remaining: async ids => (calls.push(['remaining', ids]), 0),
  };
  const surface = paymentsSurface(port, async () => ['s1', 's2']);
  it('a merchant erase scrubs the merchant stores, then verifies by re-counting', async () => {
    const m: MerchantSubject = {
      kind: 'merchant',
      requestId: 'req-1',
      storeId: 's1',
      ownerUserId: 'o',
    };
    expect(await surface.eraseSubject(m)).toEqual({
      surface: 'platform-payments',
      erased: 4,
      remaining: 0,
    });
    expect(calls).toEqual([
      ['scrub', ['s1', 's2', 'req-1']],
      ['remaining', ['s1', 's2']],
    ]);
  });
  it('a CUSTOMER erase never touches platform payer rows, and the export part is empty', async () => {
    calls.length = 0;
    const c: CustomerSubject = {
      kind: 'customer',
      requestId: 'r',
      buyerKey: 'b'.repeat(64),
      email: 'a@b.c',
      userId: 'u',
    };
    expect(await surface.eraseSubject(c)).toEqual({
      surface: 'platform-payments',
      erased: 0,
      remaining: 0,
    });
    expect(calls).toEqual([]);
    expect((await surface.exportSubject(c)).records).toBe(0);
  });
});
