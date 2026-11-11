import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  EBDA_TEMPLATES,
  RETIRED_TEMPLATES,
  normalizeLegacyTemplate,
} from '../../shared/src/templates/legacy-skin-map';
import { PKG, expectThrows, migrationFiles, openDb } from './helpers';

/**
 * Ruling SKIN-DEL-9 (R20 cleanup): D1 `stores.template` may hold only a current Ebda template. Migration 0009 moves a
 * store on a retired skin to the template it already renders as, and two triggers refuse a retired value afterwards.
 */

// 0010+ (Ruling SKIN-DEL-10) come after 0009; the 0009 tests below stop AT 0009 (`beforeMigration`, MIGRATION).
const files = migrationFiles('platform');
// The retired ids are named only through the shared reader's list (tests/unit/no-retired-skin-strings.test.ts).
const [MODERN, , , , ELEGANT] = RETIRED_TEMPLATES;
const MIGRATION = files.find(f => f.endsWith('0009_store_template_current.sql'))!;

/** A D1 at production's current state: every migration BEFORE 0009. */
function beforeMigration(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of files.filter(f => f < MIGRATION)) db.exec(fs.readFileSync(f, 'utf8'));
  return db;
}

const template = (db: DatabaseSync, id: string) =>
  (db.prepare('SELECT template FROM stores WHERE id = ?').get(id) as { template: string }).template;
const addStore = (db: DatabaseSync, id: string, tpl: string) =>
  db
    .prepare(
      `INSERT INTO stores (id, name, slug, owner_id, template, status) VALUES (?, ?, ?, 'o', ?, 'inactive')`
    )
    .run(id, id, id, tpl);

describe('D1 0009: stores on a retired skin move to a current template (Ruling SKIN-DEL-9)', () => {
  it('exists, after 0008', () => {
    expect(MIGRATION).toBeTruthy();
    expect(files.indexOf(MIGRATION)).toBeGreaterThanOrEqual(0);
  });

  it('production before 0009 still accepts a retired skin (the defect this fixes)', () => {
    const db = beforeMigration();
    addStore(db, 'qa', MODERN);
    expect(template(db, 'qa')).toBe(MODERN);
  });

  it('each retired skin moves to the template readers already map it to, so nothing changes on screen', () => {
    const db = beforeMigration();
    for (const skin of RETIRED_TEMPLATES) addStore(db, `s-${skin}`, skin);
    for (const tpl of EBDA_TEMPLATES) addStore(db, `c-${tpl}`, tpl);
    db.prepare(`UPDATE stores SET look = 'souq.catalogue' WHERE id = 's-modern'`).run();
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    for (const skin of RETIRED_TEMPLATES)
      expect(template(db, `s-${skin}`), skin).toBe(normalizeLegacyTemplate(skin));
    for (const tpl of EBDA_TEMPLATES) expect(template(db, `c-${tpl}`), tpl).toBe(tpl);
    // the look is left as it was (NULL = the template default, what the mapped read showed)
    expect(db.prepare(`SELECT look FROM stores WHERE id = 's-modern'`).get()).toEqual({
      look: 'souq.catalogue',
    });
  });

  it('touches no other row or table: the store keeps its children (no table rebuild)', () => {
    const db = beforeMigration();
    addStore(db, 'qa', MODERN);
    db.prepare(
      `INSERT INTO store_features (id, store_id, feature_key) VALUES ('f1', 'qa', 'x')`
    ).run();
    const before = db.prepare('SELECT COUNT(*) n FROM store_features').get();
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    expect(db.prepare('SELECT COUNT(*) n FROM store_features').get()).toEqual(before);
    expect(db.prepare(`SELECT name, slug, status FROM stores WHERE id = 'qa'`).get()).toEqual({
      name: 'qa',
      slug: 'qa',
      status: 'inactive',
    });
  });

  it('0009 alone refuses a retired or unknown template on insert and update; a current one is fine', () => {
    const db = beforeMigration();
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    db.exec(fs.readFileSync(MIGRATION, 'utf8')); // idempotent
    for (const bad of [...RETIRED_TEMPLATES, 'nope']) {
      expectThrows(() => addStore(db, `n-${bad}`, bad), /current Ebda template|CHECK constraint/);
    }
    addStore(db, 'ok', 'lamma');
    for (const bad of RETIRED_TEMPLATES)
      expectThrows(
        () => db.prepare(`UPDATE stores SET template = ? WHERE id = 'ok'`).run(bad),
        /current Ebda template/
      );
    db.prepare(`UPDATE stores SET template = 'dahab' WHERE id = 'ok'`).run();
    db.prepare(`UPDATE stores SET name = 'renamed' WHERE id = 'ok'`).run();
    expect(template(db, 'ok')).toBe('dahab');
  });

  it('the trigger list and the CASE name exactly the current templates (no drift from the shared registry)', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const lists = [...sql.matchAll(/NOT IN \(([^)]*)\)/g)].map(m =>
      m[1].split(',').map(s => s.trim().replace(/'/g, ''))
    );
    expect(lists.length).toBe(3);
    for (const l of lists) expect([...l].sort()).toEqual([...EBDA_TEMPLATES].sort());
    for (const skin of RETIRED_TEMPLATES)
      expect(sql).toContain(`WHEN '${skin}' THEN '${normalizeLegacyTemplate(skin)}'`);
  });

  it('why not a rebuilt CHECK: on SQLite (and D1) dropping `stores` cascades into its children even with FKs deferred', () => {
    const db = beforeMigration();
    addStore(db, 'qa', MODERN);
    db.prepare(
      `INSERT INTO store_features (id, store_id, feature_key) VALUES ('f1', 'qa', 'x')`
    ).run();
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec('DROP TABLE stores');
    expect(db.prepare('SELECT COUNT(*) n FROM store_features').get()).toEqual({ n: 0 });
    db.exec('ROLLBACK');
  });
});

describe('StoreDO 0004: the store_profile copy follows the same rule (Ruling SKIN-DEL-9)', () => {
  const storeFiles = migrationFiles('store');
  const STORE_MIGRATION = storeFiles.find(f => f.endsWith('0004_template_current.sql'))!;
  const profile = (db: DatabaseSync, tpl: string) =>
    db
      .prepare(
        `INSERT INTO store_profile (store_id, name, slug, owner_id, template) VALUES ('s1', 'Shop', 'shop', 'o', ?)`
      )
      .run(tpl);

  it('a DO before 0004 holding a retired skin moves to the mapped template; later writes of one are refused', () => {
    for (const skin of RETIRED_TEMPLATES) {
      const db = new DatabaseSync(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      for (const f of storeFiles.filter(f => f < STORE_MIGRATION))
        db.exec(fs.readFileSync(f, 'utf8'));
      profile(db, skin);
      db.exec(fs.readFileSync(STORE_MIGRATION, 'utf8'));
      expect(db.prepare('SELECT template FROM store_profile').get(), skin).toEqual({
        template: normalizeLegacyTemplate(skin),
      });
      expectThrows(
        () => db.prepare('UPDATE store_profile SET template = ?').run(skin),
        /current Ebda template/
      );
    }
  });

  it('0004 alone, on a fresh DO, refuses a retired skin on insert', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of storeFiles.filter(f => f <= STORE_MIGRATION))
      db.exec(fs.readFileSync(f, 'utf8'));
    expectThrows(() => profile(db, ELEGANT), /current Ebda template|CHECK constraint/);
    profile(db, 'jasmine');
  });
});

/**
 * Ruling SKIN-DEL-10 (expand/contract): migrations run BEFORE the deploy, so the previous release (and a rolled-back one)
 * keeps writing against the new schema. The shipped migration set must never reject a value that release writes, and a
 * backup taken by it must load into a database built from the shipped set.
 */
describe('expand-only: the shipped migrations do not reject a retired template (Ruling SKIN-DEL-10)', () => {
  const templateTriggers = (db: DatabaseSync) =>
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%template_current%'`
        )
        .all() as { name: string }[]
    ).map(r => r.name);

  it('D1 after every shipped migration: no rejecting template trigger; an old isolate writing a retired skin succeeds', () => {
    const db = openDb('platform', 2);
    expect(templateTriggers(db)).toEqual([]);
    for (const skin of RETIRED_TEMPLATES) addStore(db, `old-${skin}`, skin);
    db.prepare(`UPDATE stores SET template = ? WHERE id = ?`).run(MODERN, 'old-' + ELEGANT);
    expect(template(db, `old-${ELEGANT}`)).toBe(MODERN);
    // every stored value still reads as a current template
    for (const skin of RETIRED_TEMPLATES)
      expect(EBDA_TEMPLATES).toContain(normalizeLegacyTemplate(template(db, `old-${skin}`)));
  });

  it('StoreDO after every shipped migration: same', () => {
    const db = openDb('store', 2);
    expect(templateTriggers(db)).toEqual([]);
    db.prepare(
      `INSERT INTO store_profile (store_id, name, slug, owner_id, template) VALUES ('s1', 'Shop', 'shop', 'o', ?)`
    ).run(ELEGANT);
    db.prepare('UPDATE store_profile SET template = ?').run(MODERN);
  });

  it('prod at 0009 (triggers live) upgrades to the shipped set: triggers gone, original kept for the known QA row, the remap stays', () => {
    const db = beforeMigration();
    addStore(db, 'qa', MODERN);
    db.prepare(`UPDATE stores SET slug = 'qa-walk-store-1010' WHERE id = 'qa'`).run();
    db.exec(fs.readFileSync(MIGRATION, 'utf8'));
    expect(templateTriggers(db).length).toBe(2);
    for (const f of files.filter(f => f > MIGRATION)) db.exec(fs.readFileSync(f, 'utf8'));
    expect(templateTriggers(db)).toEqual([]);
    expect(
      db.prepare(`SELECT template, template_original FROM stores WHERE id = 'qa'`).get()
    ).toEqual({ template: 'souq', template_original: MODERN });
  });

  it('a pre-0009 backup (retired skins in its rows) loads into a database built from the shipped migrations', () => {
    const old = beforeMigration();
    for (const skin of RETIRED_TEMPLATES) addStore(old, `s-${skin}`, skin);
    const rows = old.prepare('SELECT * FROM stores').all() as Record<string, unknown>[];
    const cols = Object.keys(rows[0]);
    const target = openDb('platform');
    const ins = target.prepare(
      `INSERT INTO stores (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const r of rows) ins.run(...(cols.map(c => r[c]) as never[]));
    expect(target.prepare('SELECT COUNT(*) n FROM stores').get()).toEqual({
      n: RETIRED_TEMPLATES.length,
    });
  });
});

/** The contract step is parked outside `migrations/`; it must work on top of the shipped set, and must not ship early. */
describe('contract step is parked, not shipped (Ruling SKIN-DEL-10)', () => {
  const pendingDir = path.join(PKG, 'migrations-pending');
  const pending = (t: string) =>
    fs.readFileSync(path.join(pendingDir, t, fs.readdirSync(path.join(pendingDir, t))[0]), 'utf8');

  it('is not in migrations/ and not in STORE_MIGRATIONS', async () => {
    for (const t of ['platform', 'store'] as const)
      for (const f of migrationFiles(t)) expect(path.basename(f)).not.toMatch(/contract/);
    const { STORE_MIGRATIONS } = await import('../src/store/migrations.generated');
    expect(STORE_MIGRATIONS.map(m => m.id).join()).not.toMatch(/contract/);
  });

  it('on top of the shipped D1 set it remaps, records the original, then refuses a retired skin', () => {
    const db = openDb('platform');
    addStore(db, 'late', ELEGANT);
    db.exec(pending('platform'));
    expect(
      db.prepare(`SELECT template, template_original FROM stores WHERE id = 'late'`).get()
    ).toEqual({ template: normalizeLegacyTemplate(ELEGANT), template_original: ELEGANT });
    expectThrows(() => addStore(db, 'x', MODERN), /current Ebda template/);
  });

  it('on top of the shipped DO set it refuses a retired skin', () => {
    const db = openDb('store');
    db.exec(pending('store'));
    expectThrows(
      () =>
        db
          .prepare(
            `INSERT INTO store_profile (store_id, name, slug, owner_id, template) VALUES ('s1', 'S', 's', 'o', ?)`
          )
          .run(MODERN),
      /current Ebda template/
    );
  });
});
