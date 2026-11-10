import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  EBDA_TEMPLATES,
  RETIRED_TEMPLATES,
  normalizeLegacyTemplate,
} from '../../shared/src/templates/legacy-skin-map';
import { expectThrows, migrationFiles, openDb } from './helpers';

/**
 * Ruling SKIN-DEL-9 (R20 cleanup): D1 `stores.template` may hold only a current Ebda template. Migration 0009 moves a
 * store on a retired skin to the template it already renders as, and two triggers refuse a retired value afterwards.
 */

const files = migrationFiles('platform');
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
    expect(files.indexOf(MIGRATION)).toBe(files.length - 1);
  });

  it('production before 0009 still accepts a retired skin (the defect this fixes)', () => {
    const db = beforeMigration();
    addStore(db, 'qa', 'modern');
    expect(template(db, 'qa')).toBe('modern');
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
    addStore(db, 'qa', 'modern');
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

  it('after 0009 a retired or unknown template is refused on insert and update; a current one is fine', () => {
    const db = openDb('platform', 2); // all migrations, twice: 0009 is idempotent
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
    addStore(db, 'qa', 'modern');
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

  it('a fresh DO (all migrations, twice) refuses a retired skin on insert', () => {
    const db = openDb('store', 2);
    expectThrows(() => profile(db, 'elegant'), /current Ebda template|CHECK constraint/);
    profile(db, 'jasmine');
  });
});
