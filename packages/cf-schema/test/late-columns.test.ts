// N-10c: a column added after 0001 reached the live database is declared ONCE (scripts/cf-additions.mjs, `since`), the
// generator keeps it out of 0001 and emits the numbered ALTER, and a fresh database and an upgraded one end up identical.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LATE_COLUMN_MIGRATIONS, extraColumns } from '../scripts/cf-additions.mjs';
import { PKG, migrationFiles, readJson } from './helpers';

const files = migrationFiles('platform');
const read = (f: string) => fs.readFileSync(f, 'utf8');
const byName = (n: string) => files.find(f => path.basename(f).startsWith(n))!;

function apply(list: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of list) db.exec(read(f));
  return db;
}
const snapshot = (db: DatabaseSync) => ({
  columns: Object.fromEntries(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as { name: string }[]
    ).map(t => [
      t.name,
      (
        db.prepare(`PRAGMA table_info("${t.name}")`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }[]
      )
        .map(c => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`)
        .sort(),
    ])
  ),
  schemaObjects: (
    db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all() as {
      type: string;
      name: string;
    }[]
  ).map(r => `${r.type}:${r.name}`),
});

const late = Object.entries(
  extraColumns as Record<string, Array<{ column: string; cfSince?: number }>>
).flatMap(([model, cols]) =>
  cols.filter(c => c.cfSince).map(c => ({ model, column: c.column, since: c.cfSince! }))
);

describe('late columns (declared once, applied once)', () => {
  it('every late column is declared in cf-additions, absent from 0001, and added by exactly one numbered migration', () => {
    expect(late.length).toBeGreaterThan(0);
    const init = read(byName('0001'));
    const numbered = Object.fromEntries(
      Object.entries(LATE_COLUMN_MIGRATIONS as Record<string, string>).map(([n, name]) => [
        Number(n),
        read(byName(`${String(n).padStart(4, '0')}_${name}`)),
      ])
    );
    for (const c of late) {
      expect(init, `0001 must not carry ${c.column}`).not.toMatch(new RegExp(`"${c.column}"`));
      const hits = Object.values(numbered).filter(sql => sql.includes(`ADD COLUMN "${c.column}"`));
      expect(hits, c.column).toHaveLength(1);
      expect(numbered[c.since], c.column).toContain(`ADD COLUMN "${c.column}"`);
    }
    // and nothing is added there that cf-additions does not declare
    const added = Object.values(numbered).flatMap(sql =>
      [...sql.matchAll(/ADD COLUMN "(\w+)"/g)].map(m => m[1])
    );
    expect(added.sort()).toEqual(late.map(c => c.column).sort());
  });

  it('all migrations on an EMPTY D1 produce exactly the schema the generator manifest describes', () => {
    const db = apply(files);
    const manifest = readJson<{
      databases: Record<string, { columnCounts: Record<string, number> }>;
    }>('generated/manifest.json');
    const counts = Object.fromEntries(
      Object.keys(manifest.databases.d1.columnCounts).map(t => [
        t,
        (db.prepare(`PRAGMA table_info("${t}")`).all() as unknown[]).length,
      ])
    );
    expect(counts).toEqual(manifest.databases.d1.columnCounts);
    for (const c of late) {
      const table = c.model === 'Store' ? 'stores' : 'billing_events';
      const names = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        x => x.name
      );
      expect(
        names.filter(n => n === c.column),
        c.column
      ).toHaveLength(1);
    }
  });

  it('a database already at 0001+0002 (production today) upgrades to the same schema as a fresh one, and backfills', () => {
    const live = apply(files.filter(f => /\/000[12]_/.test(f)));
    live.exec(`INSERT INTO stores (id, name, slug, owner_id) VALUES ('s', 's', 's', 'o')`);
    live
      .prepare(
        `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, vat_minor, vat) VALUES ('e1', 's', 'renewal', 11400, 'k', 'k1', 1400, '{"rateBps":1400}'), ('e2', 's', 'card_setup', 0, 'k', 'k2', 0, NULL)`
      )
      .run();
    for (const f of files.filter(f => !/\/000[12]_/.test(f))) live.exec(read(f));
    expect(snapshot(live)).toEqual(snapshot(apply(files)));
    expect(
      live
        .prepare(
          'SELECT net_minor n, gross_minor g, vat_rate_bp r, eta_status e FROM billing_events WHERE id = ?'
        )
        .get('e1')
    ).toEqual({ n: 10000, g: 11400, r: 1400, e: 'not_submitted' });
    expect(
      live
        .prepare(
          'SELECT net_minor n, gross_minor g, vat_rate_bp r FROM billing_events WHERE id = ?'
        )
        .get('e2')
    ).toEqual({ n: 0, g: 0, r: 0 });
  });

  it('the generated numbered migration is current (regenerate and diff)', () => {
    const generated = read(byName('0003'));
    expect(generated.startsWith('-- @generated by packages/cf-schema/scripts/generate.mjs')).toBe(
      true
    );
    expect(generated).toMatch(/^-- @once/m);
    expect(fs.existsSync(path.join(PKG, 'scripts/cf-additions.mjs'))).toBe(true);
  });
});

describe('0004 billing tax columns', () => {
  const ins = (db: DatabaseSync, extra: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: crypto.randomUUID(),
      store_id: 's',
      type: 'renewal',
      amount_minor: 11400,
      provider: 'kashier',
      idempotency_key: crypto.randomUUID(),
      vat_minor: 1400,
      vat: JSON.stringify({ rateBps: 1400 }),
      ...extra,
    };
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO billing_events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...(row ? (Object.values(row) as never[]) : []));
    return row.id as string;
  };
  const fresh = () => {
    const db = apply(files);
    db.exec(`INSERT INTO stores (id, name, slug, owner_id) VALUES ('s', 's', 's', 'o')`);
    return db;
  };
  const get = (db: DatabaseSync, id: string) =>
    db
      .prepare(
        'SELECT net_minor n, vat_minor v, gross_minor g, vat_rate_bp r, eta_status e FROM billing_events WHERE id = ?'
      )
      .get(id);

  it('a writer that knows nothing of the new columns gets them filled', () => {
    const db = fresh();
    expect(get(db, ins(db))).toEqual({ n: 10000, v: 1400, g: 11400, r: 1400, e: 'not_submitted' });
    expect(get(db, ins(db, { amount_minor: 0, vat_minor: 0, vat: null }))).toMatchObject({
      n: 0,
      g: 0,
      r: 0,
    });
  });

  it('rejects gross != net + vat and a rate that does not produce the vat', () => {
    const db = fresh();
    expect(() => ins(db, { net_minor: 10000, gross_minor: 99999 })).toThrow(
      /gross_minor must equal/
    );
    expect(() =>
      ins(db, { net_minor: 10000, gross_minor: 11700, vat_rate_bp: 1400, vat_minor: 1700 })
    ).toThrow(/vat_minor is not round/);
    expect(() =>
      ins(db, { net_minor: 10000, gross_minor: 11400, vat_rate_bp: 1400 })
    ).not.toThrow();
  });

  it('the money columns freeze once filled; the e-invoice columns and status stay editable', () => {
    const db = fresh();
    const id = ins(db);
    expect(() =>
      db.prepare('UPDATE billing_events SET net_minor = 1 WHERE id = ?').run(id)
    ).toThrow();
    expect(() =>
      db.prepare('UPDATE billing_events SET vat_rate_bp = 0 WHERE id = ?').run(id)
    ).toThrow(/append-only/);
    db.prepare(
      `UPDATE billing_events SET eta_status = 'submitted', eta_uuid = 'u', eta_submitted_at = 1 WHERE id = ?`
    ).run(id);
    expect((get(db, id) as { e: string }).e).toBe('submitted');
    expect(() =>
      db.prepare(`UPDATE billing_events SET eta_status = 'maybe' WHERE id = ?`).run(id)
    ).toThrow();
    db.prepare(`UPDATE billing_events SET status = 'succeeded' WHERE id = ?`).run(id); // the settle CAS is still legal
  });
});

describe('0007 / 0008 FOLD-VAT: ETA document fields and the seller snapshot', () => {
  const fresh = () => {
    const db = apply(files);
    db.exec(`INSERT INTO stores (id, name, slug, owner_id) VALUES ('s', 's', 's', 'o')`);
    return db;
  };
  const insert = (db: DatabaseSync, amount: number, vatMinor: number, vat: object | null) => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, vat_minor, vat) VALUES (?, 's', 'renewal', ?, 'kashier', ?, ?, ?)`
    ).run(id, amount, id, vatMinor, vat ? JSON.stringify(vat) : null);
    return id;
  };
  const row = (db: DatabaseSync, id: string) =>
    db
      .prepare(
        `SELECT net_minor n, gross_minor g, vat_rate_bp r, seller_tax_id t, seller_legal_name l, buyer_tax_id b,
                eta_status s, eta_uuid u, eta_long_id li, eta_hash h, eta_rejection_reason rr, eta_submitted_at sa
           FROM billing_events WHERE id = ?`
      )
      .get(id);

  it('VAT off: totals identical to today, rate 0, every tax / ETA field empty or defaulted', () => {
    const db = fresh();
    expect(row(db, insert(db, 29900, 0, null))).toEqual({
      n: 29900,
      g: 29900,
      r: 0,
      t: null,
      l: null,
      b: null,
      s: 'not_submitted',
      u: null,
      li: null,
      h: null,
      rr: null,
      sa: null,
    });
  });

  it('VAT on: the seller registration snapshot is copied from the charge into the columns', () => {
    const db = fresh();
    const r = row(
      db,
      insert(db, 34086, 4186, { rateBps: 1400, trn: '123-456-789', legalName: 'Ebda Studio' })
    );
    expect(r).toMatchObject({
      n: 29900,
      g: 34086,
      r: 1400,
      t: '123-456-789',
      l: 'Ebda Studio',
      s: 'not_submitted',
    });
  });

  it('the ETA document columns accept a full lifecycle and stay editable after the money froze', () => {
    const db = fresh();
    const id = insert(db, 11400, 1400, { rateBps: 1400, trn: null, legalName: null });
    db.prepare(
      `UPDATE billing_events SET eta_status = 'rejected', eta_uuid = 'u', eta_long_id = 'L', eta_hash = 'H',
              eta_rejection_reason = 'bad tax id', eta_submitted_at = 5 WHERE id = ?`
    ).run(id);
    expect(row(db, id)).toMatchObject({ s: 'rejected', li: 'L', h: 'H', rr: 'bad tax id', sa: 5 });
  });
});
