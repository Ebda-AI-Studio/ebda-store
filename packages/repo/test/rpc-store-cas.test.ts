/**
 * Issue #620 / Ruling NEVER-OVERWRITE-1: `casStoreFields` writes a Store field only while it still holds the value the AI job
 * read. A merchant edit made mid-run wins; the job's value is reported stale and never lands.
 */
import { describe, expect, it } from 'vitest';
import { applyStoreSettings, casStoreFields, readStoreRecord } from '../src/rpc/settings';
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
const cas = (sql: SqlRunner, expect: Record<string, unknown>, set: Record<string, unknown>) =>
  casStoreFields(sql, META as never, 's1', { expect, set });

describe('casStoreFields', () => {
  it('fills a field that is still blank (null, empty and whitespace all count as blank)', () => {
    const { sql } = rig();
    expect(cas(sql, { metaTitle: null }, { metaTitle: 'AI title' }).written).toEqual(['metaTitle']);
    expect(read(sql, ['metaTitle']).metaTitle).toBe('AI title');
    applyStoreSettings(sql, META as never, 's1', { metaTitleAr: '   ' });
    expect(cas(sql, { metaTitleAr: null }, { metaTitleAr: 'عنوان' }).written).toEqual([
      'metaTitleAr',
    ]);
  });

  it('a merchant edit made mid-run wins: the job read blank, the merchant typed, the job write is stale', () => {
    const { sql } = rig();
    // the job read metaTitle as blank ... the merchant saves their own title while the AI call runs ...
    applyStoreSettings(sql, META as never, 's1', { metaTitle: 'merchant title' });
    // ... the job then writes
    const r = cas(sql, { metaTitle: null }, { metaTitle: 'AI title' });
    expect(r.written).toEqual([]);
    expect(r.stale).toEqual(['metaTitle']);
    expect(read(sql, ['metaTitle']).metaTitle).toBe('merchant title');
  });

  it('force: writes over the value read, but not over a value changed since', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', { llmsTxt: 'old ai text' });
    expect(cas(sql, { llmsTxt: 'old ai text' }, { llmsTxt: 'new' }).written).toEqual(['llmsTxt']);
    applyStoreSettings(sql, META as never, 's1', { llmsTxt: 'merchant text' });
    expect(cas(sql, { llmsTxt: 'new' }, { llmsTxt: 'newer' }).stale).toEqual(['llmsTxt']);
    expect(read(sql, ['llmsTxt']).llmsTxt).toBe('merchant text');
  });

  it('is per field: the untouched field is written, the edited one is not', () => {
    const { sql } = rig();
    applyStoreSettings(sql, META as never, 's1', { metaDescription: 'merchant' });
    const r = cas(
      sql,
      { metaTitle: null, metaDescription: null },
      { metaTitle: 'AI t', metaDescription: 'AI d' }
    );
    expect(r.written).toEqual(['metaTitle']);
    expect(r.stale).toEqual(['metaDescription']);
  });

  it('a blank Json field (null or {}) is fillable', () => {
    const { sql } = rig();
    expect(cas(sql, { aboutJson: null }, { aboutJson: { a: 1 } }).written).toEqual(['aboutJson']);
    expect(read(sql, ['aboutJson']).aboutJson).toEqual({ a: 1 });
  });
});
