/**
 * BE:F-2 / BE:F-3: the DO's atomic settings PATCH (`patchStoreSettings`). Two saves of different keys both survive, and a bundle
 * with a refused part writes NOTHING (one DO transaction).
 */
import { describe, expect, it } from 'vitest';
import { applyStoreSettings, patchStoreSettings, readStoreRecord } from '../src/rpc/settings';
import type { SqlRunner } from '../src/prisma-lite/types';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';
import { nodeSyncSql } from './node-sync-sql';

function rig() {
  const db = openSqlite();
  const sync = nodeSyncSql(db);
  const sql: SqlRunner = { ...nodeSqlRunner(db), transactionSync: sync.transactionSync };
  db.prepare(
    `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('s1', 'n', 'n', 'o')`
  ).run();
  return { sql };
}
const read = (sql: SqlRunner, names: string[]) =>
  readStoreRecord(sql, META as never, 's1', names)!.record;

describe('patchStoreSettings', () => {
  it('two interleaved saves of different keys both survive (the lost update)', async () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', { settings: { base: 1 } });
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        Promise.resolve().then(() =>
          patchStoreSettings(sql, META as never, 's1', {
            json: { settings: { set: { checkoutDelivery: { i } } } },
          })
        ),
        Promise.resolve().then(() =>
          patchStoreSettings(sql, META as never, 's1', {
            json: { settings: { set: { contact: { i } } } },
          })
        ),
      ]);
      expect(read(sql, ['settings']).settings, `round ${i}`).toEqual({
        base: 1,
        checkoutDelivery: { i },
        contact: { i },
      });
    }
  });

  it('theme save, social save and settings save each interleave with a second writer of the SAME column and both survive', async () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', {
      settings: { base: 1 },
      theme: { base: 1 },
      socialLinks: { base: 'u' },
    });
    const patch = (json: Record<string, { set?: Record<string, unknown>; remove?: string[] }>) =>
      Promise.resolve().then(() => patchStoreSettings(sql, META as never, 's1', { json }));
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        // PUT /theme and the branding bundle's theme part
        patch({ theme: { set: { font: `f${i}` }, remove: ['gone'] } }),
        patch({ theme: { set: { color: `c${i}` } } }),
        // PUT /social and the bundle's social part
        patch({ socialLinks: { set: { instagram: `i${i}` }, remove: ['tiktok'] } }),
        patch({ socialLinks: { set: { x: `x${i}` } } }),
        // settings save and a per-key setter
        patch({ settings: { set: { contact: { i } } } }),
        patch({ settings: { set: { floatingWidget: { i } } } }),
      ]);
      expect(read(sql, ['settings', 'theme', 'socialLinks']), `round ${i}`).toEqual({
        settings: { base: 1, contact: { i }, floatingWidget: { i } },
        theme: { base: 1, font: `f${i}`, color: `c${i}` },
        socialLinks: { base: 'u', instagram: `i${i}`, x: `x${i}` },
      });
    }
  });

  it('writes only the sent keys; theme/social support removal; plain fields ride the same transaction', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', {
      settings: { keep: true, drop: 1 },
      theme: { a: 1, b: 2 },
      socialLinks: { x: 'u' },
    });
    patchStoreSettings(sql, META as never, 's1', {
      fields: { heroTitle: 'Hi' },
      json: {
        settings: { set: { added: 2 }, remove: ['drop'] },
        theme: { set: { c: 3 }, remove: ['a'] },
        socialLinks: { set: { y: 'v' } },
      },
    });
    expect(read(sql, ['settings', 'theme', 'socialLinks', 'heroTitle'])).toMatchObject({
      settings: { keep: true, added: 2 },
      theme: { b: 2, c: 3 },
      socialLinks: { x: 'u', y: 'v' },
      heroTitle: 'Hi',
    });
    expect(read(sql, ['settings']).settings).not.toHaveProperty('drop');
  });

  it('a refused part writes NOTHING (no partial bundle)', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', { settings: { keep: true }, heroTitle: 'old' });
    expect(() =>
      patchStoreSettings(sql, META as never, 's1', {
        fields: { heroTitle: 'new', notAField: 1 },
        json: { settings: { set: { added: 1 } }, theme: { set: { c: 1 } } },
      })
    ).toThrow(/unknown Store field/);
    expect(read(sql, ['settings', 'theme', 'heroTitle'])).toMatchObject({
      settings: { keep: true },
      theme: {},
      heroTitle: 'old',
    });
  });

  it('refuses a JSON field outside the whitelist and a store without a profile row', () => {
    const { sql } = rig();
    expect(() =>
      patchStoreSettings(sql, META as never, 's1', { json: { plan: { set: { a: 1 } } } })
    ).toThrow(/not a patchable JSON field/);
    expect(() =>
      patchStoreSettings(sql, META as never, 'nope', { json: { settings: { set: { a: 1 } } } })
    ).toThrow(/store_profile row is missing/);
  });
});
