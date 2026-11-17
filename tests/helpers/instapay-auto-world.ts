/**
 * A D1-shaped world for the InstaPay auto-confirm money path (Ruling INSTAPAY-AUTO-1): the REAL platform migrations on node:sqlite behind the
 * D1 API (batch = one transaction), the REAL platform router (billing / payments / platform families on D1) and a SECOND database holding the
 * REAL dedupe schema bound as INSTAPAY_DEDUPE_DB, so the cross-merchant duplicate index runs the production SQL. Call `vi.mock`s in the test file
 * (they hoist); this file only builds data.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEDUPE_SCHEMA_SQL } from '../../packages/shared/src/foundation/instapay-dedupe';
import { setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';

export const HANDLE = 'ebda@instapay';
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';

const MIGRATIONS = ['0001_init', '0002_invariants', '0014_instapay_auto_confirm']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}.sql`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');

export function d1Over(db: DatabaseSync) {
  const stmt = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
  const prep = (sql: string) => ({
    bind: (...v: unknown[]) => ({
      all: async () => (await Promise.resolve(), stmt(sql, v)),
      run: async () => (await Promise.resolve(), stmt(sql, v)),
      first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      __run: () => stmt(sql, v),
    }),
    all: async () => (await Promise.resolve(), stmt(sql, [])),
    first: async () => (await Promise.resolve(), (stmt(sql, []).results[0] ?? null) as never),
  });
  return {
    prepare: prep,
    batch: async (l: Array<{ __run: () => { meta: { changes: number } } }>) => {
      db.exec('BEGIN');
      try {
        const out = l.map(s => s.__run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export type World = ReturnType<typeof buildWorld>;

export function buildWorld(opts: { dedupe?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATIONS);
  const dd = new DatabaseSync(':memory:');
  dd.exec(DEDUPE_SCHEMA_SQL);
  for (const [id, slug] of [
    [A, 'a'],
    [B, 'b'],
  ])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'o')`).run(
      id,
      slug,
      slug
    );
  db.prepare(
    `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES ('p', 'growth', 'g', 'g', 'professional', '{}', 5000, 50000)`
  ).run();
  for (const fam of ['billing', 'payments', 'platform'])
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES (?, ?, '{}')`).run(
      `c-${fam}`,
      cutoverKey(fam as never)
    );
  const bindings: Record<string, unknown> = { PLATFORM_DB: d1Over(db) };
  if (opts.dedupe !== false) bindings.INSTAPAY_DEDUPE_DB = d1Over(dd);
  resetCutoverCache();
  setCfBindings(bindings as never);
  return { db, dd, bindings };
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export type Seed = {
  storeId?: string;
  interval?: 'monthly' | 'yearly';
  amountMinor?: number;
  reference?: string;
  sha?: string;
  /** the typed auto read; null = unreadable; omitted = a clean full match */
  read?: unknown;
  claimedAt?: number;
  extractionStatus?: string;
};

/** The receipt's auto read for a full match at `now` (everything the decision compares). */
export function goodRead(over: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
  return {
    extract: {
      amountMinor: 5000,
      recipientHandle: HANDLE,
      transferredAt: Date.now() - 3600_000,
      reference: '123456789012',
      ...over,
    },
    flags: { looksEdited: false, suspiciousText: false, confidence: 0.95, ...flags },
  };
}

/** One submitted subscription receipt + its pending claim; returns their ids. */
export function seedClaim(w: World, s: Seed = {}) {
  const storeId = s.storeId ?? A;
  const interval = s.interval ?? 'monthly';
  const amountMinor = s.amountMinor ?? (interval === 'yearly' ? 50000 : 5000);
  const reference = s.reference ?? '123456789012';
  const claimId = uuid();
  const receiptId = uuid();
  const sha = s.sha ?? crypto.createHash('sha256').update(receiptId).digest('hex');
  const hasSub = w.db
    .prepare('SELECT 1 x FROM store_subscriptions WHERE store_id = ?')
    .get(storeId);
  if (!hasSub)
    w.db
      .prepare(
        `INSERT INTO store_subscriptions (id, store_id, plan_code, status, updated_at, payment_reference) VALUES (?, ?, 'growth', 'trialing', 1, ?)`
      )
      .run(uuid(), storeId, `EBD-${storeId.slice(-12)}`);
  w.db
    .prepare(
      `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, method, payment_reference, payer_reference, status, created_at) VALUES (?, ?, 'growth', ?, ?, 'instapay', ?, ?, 'pending', ?)`
    )
    .run(
      claimId,
      storeId,
      interval,
      amountMinor,
      `EBD-${receiptId.slice(-6)}`,
      reference,
      s.claimedAt ?? Date.now() - 1000
    );
  const auto = s.read === undefined ? goodRead({ reference }) : s.read;
  w.db
    .prepare(
      `INSERT INTO instapay_receipts (id, store_id, kind, claim_id, storage_key, mime_type, size_bytes, sha256, extraction_status, extracted, status, reference, reference_key) VALUES (?, ?, 'subscription', ?, 'k', 'image/png', 10, ?, ?, ?, 'submitted', ?, ?)`
    )
    .run(
      receiptId,
      storeId,
      claimId,
      sha,
      s.extractionStatus ?? 'done',
      JSON.stringify({ auto: { read: auto, at: 'x' } }),
      reference,
      reference
    );
  return { claimId, receiptId, storeId, sha, reference };
}
