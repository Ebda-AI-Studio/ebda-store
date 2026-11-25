// G10 contract with the erasure registry (apps/api/src/cf/erasure/registry.ts, PR #208): every StoreDO and D1
// table is classified for personal data, and a column that LOOKS personal must be decided, not skipped.
import { describe, expect, it } from 'vitest';
import { openDb, readJson, tableNames } from './helpers';

type Entry = {
  db: 'store-do' | 'd1';
  class: string;
  action: string;
  piiColumns: string[];
  subjectKeys: string[];
  reviewedNotPii?: string[];
  userIdColumns?: string[];
  subjectColumns?: string[];
  actorScrub?: Record<string, string | null>;
  retainedUserIds?: Record<string, string>;
};
const cls = readJson<Record<string, Entry>>('erasure-classification.json');
const DBS = { 'store-do': openDb('store'), d1: openDb('platform') } as const;
const LOOKS_PERSONAL =
  /(email|phone|first_?name|last_?name|full_?name|address|^ip$|_ip$|ip_address|buyer_key|user_id|customer_id|user_agent|birth|national|tax_registration|contact|whatsapp|session_id|player_id|endpoint|p256dh|payer|last4|token|author|guest_|_by$|_by_id$|actor|_user_id$|owner_id|_name$)/i;

describe('erasure classification', () => {
  it('classifies every table of both databases, and nothing else', () => {
    const all = (Object.keys(DBS) as (keyof typeof DBS)[]).flatMap(db =>
      tableNames(DBS[db]).map(t => `${db}:${t}`)
    );
    expect(Object.keys(cls).sort()).toEqual(all.sort());
  });

  it('every named personal column exists in that table', () => {
    for (const [id, e] of Object.entries(cls)) {
      const table = id.split(':')[1];
      const cols = new Set(
        (DBS[e.db].prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
          c => c.name
        )
      );
      for (const c of [...e.piiColumns, ...(e.reviewedNotPii ?? [])])
        if (c !== '*') expect(cols.has(c), `${id}.${c}`).toBe(true);
    }
  });

  it('a column that looks personal is either listed as personal or explicitly reviewed as not (new columns force a decision)', () => {
    const undecided: string[] = [];
    for (const [id, e] of Object.entries(cls)) {
      const table = id.split(':')[1];
      if (e.piiColumns.includes('*')) continue;
      for (const c of DBS[e.db].prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[]) {
        if (
          LOOKS_PERSONAL.test(c.name) &&
          !e.piiColumns.includes(c.name) &&
          !(e.reviewedNotPii ?? []).includes(c.name)
        )
          undecided.push(`${id}.${c.name}`);
      }
    }
    expect(undecided).toEqual([]);
  });

  // OFFBOARD-1 (2026-10-26): `created_by` held a user id but was classed no-pii because the old pattern did not
  // match it, so offboarding a staff member left their id on ~30 tables. A column shaped like a user id MUST be
  // listed as personal; `reviewedNotPii` is NOT an accepted answer for it. The only escape is this list of columns
  // that are shaped like one but hold something else, each with the reason.
  const USER_ID_SHAPED = /(_by$|_by_id$|actor|_user_id$|^user_id$|owner_id$|^owner_id$)/i;
  const NOT_A_USER: Record<string, string> = {
    'store-do:journal_entries.reversed_by_id': 'id of the reversing journal entry',
    'store-do:store_config.return_fees_paid_by': "'merchant' | 'customer', not an id",
  };
  it('a column shaped like a user id is classed personal (no reviewed-not-pii escape)', () => {
    const missing: string[] = [];
    for (const [id, e] of Object.entries(cls)) {
      const table = id.split(':')[1];
      if (e.piiColumns.includes('*')) continue;
      for (const c of DBS[e.db].prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[]) {
        const key = `${id}.${c.name}`;
        if (USER_ID_SHAPED.test(c.name) && !(key in NOT_A_USER) && !e.piiColumns.includes(c.name))
          missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every user-id column is accounted for exactly once: actorScrub, subjectColumns or retainedUserIds', () => {
    const problems: string[] = [];
    for (const [id, e] of Object.entries(cls)) {
      const table = id.split(':')[1];
      const info = DBS[e.db].prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
        notnull: number;
      }[];
      const userCols = e.piiColumns.filter(c => c !== '*' && USER_ID_SHAPED.test(c));
      const groups = {
        actorScrub: Object.keys(e.actorScrub ?? {}),
        subjectColumns: e.subjectColumns ?? [],
        retainedUserIds: Object.keys(e.retainedUserIds ?? {}),
      };
      const all = Object.values(groups).flat();
      if ([...new Set(all)].length !== all.length)
        problems.push(`${id}: a column is in two groups`);
      if (JSON.stringify([...all].sort()) !== JSON.stringify([...(e.userIdColumns ?? [])].sort()))
        problems.push(`${id}: userIdColumns != actorScrub + subjectColumns + retainedUserIds`);
      for (const c of userCols)
        if (!(e.userIdColumns ?? []).includes(c)) problems.push(`${id}.${c}: not in userIdColumns`);
      for (const [c, rep] of Object.entries(e.actorScrub ?? {})) {
        const col = info.find(x => x.name === c);
        if (!col) problems.push(`${id}.${c}: no such column`);
        else if (rep === null && col.notnull)
          problems.push(`${id}.${c}: NOT NULL needs a tombstone`);
      }
    }
    expect(problems).toEqual([]);
  });

  // Follow-up of the #1109 review (Ruling NZ-D15B): a store's KEPT platform tables survive a closed-store purge (only a tombstone row
  // and scrubbed columns remain), so EVERY column of every store-keyed D1 table must have been decided: personal (piiColumns, cleared by
  // lib/store-tombstone.ts) or reviewed as not personal (reviewedNotPii). A new, unclassified column fails here until someone decides.
  // Tables the tombstone deletes outright are exempt: their rows go.
  const DELETED_BY_TOMBSTONE = new Set([
    'store_staff',
    'merchant_api_keys',
    'staff_invites',
    'SlugRedirect',
  ]);
  it('every column of every store-keyed kept D1 table is classified (a new unclassified column fails CI)', () => {
    const undecided: string[] = [];
    let checked = 0;
    for (const table of tableNames(DBS.d1)) {
      const cols = (
        DBS.d1.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
      ).map(c => c.name);
      if (!cols.includes('store_id') || DELETED_BY_TOMBSTONE.has(table)) continue;
      const e = cls[`d1:${table}`];
      if (!e) continue; // "classifies every table" owns a missing entry
      checked++;
      const decided = new Set([...e.piiColumns, ...(e.reviewedNotPii ?? [])]);
      if (decided.has('*')) continue;
      for (const c of cols) if (!decided.has(c)) undecided.push(`d1:${table}.${c}`);
    }
    expect(checked, 'the scan found the kept tables').toBeGreaterThanOrEqual(10);
    expect(undecided).toEqual([]);
  });

  it('every NOT_A_USER exception names a real column (no stale exemption)', () => {
    for (const key of Object.keys(NOT_A_USER)) {
      const [id, col] = key.split('.');
      const table = id.split(':')[1];
      const e = cls[id];
      const cols = (
        DBS[e.db].prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
      ).map(c => c.name);
      expect(cols, key).toContain(col);
    }
  });

  it('personal tables carry an action; customer tables name how a subject is found', () => {
    for (const [id, e] of Object.entries(cls)) {
      if (e.class === 'no-pii') expect(e.action, id).toBe('none');
      else expect(['delete', 'scrub', 'retain'], id).toContain(e.action);
      if (
        e.class === 'customer-pii' &&
        !e.piiColumns.includes('*') &&
        id !== 'store-do:commerce_outcomes'
      )
        expect(e.piiColumns.length, id).toBeGreaterThan(0);
    }
  });

  it('the append-only CI-1 stream can still be erased: buyer_key may be nulled only while do_flags.erasure = 1', () => {
    const db = openDb('store');
    db.prepare(
      `INSERT INTO commerce_outcomes (id, store_id, kind, order_id, buyer_key, occurred_at) VALUES ('c1','s1','cod_refused','o1','abc',1)`
    ).run();
    expect(() =>
      db.prepare(`UPDATE commerce_outcomes SET buyer_key = NULL WHERE id = 'c1'`).run()
    ).toThrow(/append-only/);
    db.prepare(`INSERT INTO do_flags (name, value) VALUES ('erasure', 1)`).run();
    db.prepare(`UPDATE commerce_outcomes SET buyer_key = NULL WHERE id = 'c1'`).run();
    expect(() =>
      db.prepare(`UPDATE commerce_outcomes SET kind = 'delivered' WHERE id = 'c1'`).run()
    ).toThrow(/append-only/);
  });
});
