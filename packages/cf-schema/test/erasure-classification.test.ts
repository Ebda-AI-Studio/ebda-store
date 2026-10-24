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
};
const cls = readJson<Record<string, Entry>>('erasure-classification.json');
const DBS = { 'store-do': openDb('store'), d1: openDb('platform') } as const;
const LOOKS_PERSONAL =
  /(email|phone|first_?name|last_?name|full_?name|address|^ip$|_ip$|ip_address|buyer_key|user_id|customer_id|user_agent|birth|national|tax_registration|contact|whatsapp|session_id|player_id|endpoint|p256dh|payer|last4|token|author|guest_)/i;

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
