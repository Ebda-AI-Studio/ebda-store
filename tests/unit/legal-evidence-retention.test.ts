/**
 * Ruling NZ-N27B: consent evidence retention on the REAL platform D1 schema (node:sqlite). ip + user agent older than 12 months become
 * NULL, rows older than RETENTION_YEARS (7) are deleted, the classification cannot ask for less than the law's floor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RETENTION_YEARS } from '../../apps/api/src/config/retention';
import {
  legalEvidenceRetentionPlan,
  monthsAgo,
  runLegalEvidenceRetention,
  yearsAgo,
} from '../../apps/api/src/services/legal-evidence-retention';

const ROOT = path.resolve(__dirname, '../..');
function platform(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(ROOT, 'packages/cf-schema/migrations/platform');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  return db;
}
const runOn =
  (db: DatabaseSync) =>
  async (sql: string, ...p: unknown[]) =>
    Number(db.prepare(sql).run(...(p as never[])).changes);
const now = Date.UTC(2026, 10, 24, 12);

function seed(db: DatabaseSync) {
  const acc = db.prepare(
    'INSERT INTO legal_acceptances (id, user_id, doc_key, version, accepted_at, ip, user_agent, source) VALUES (?,?,?,?,?,?,?,?)'
  );
  acc.run('new', 'u1', 'terms', 'v1', monthsAgo(now, 3), '1.1.1.1', 'UA', 'signup');
  acc.run('mid', 'u2', 'terms', 'v1', monthsAgo(now, 13), '2.2.2.2', 'UA', 'signup');
  acc.run('old', 'u3', 'terms', 'v1', yearsAgo(now, 8), '3.3.3.3', 'UA', 'signup');
  const del = db.prepare(
    'INSERT INTO legal_notice_deliveries (id, user_id, doc_key, version, status, error, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  del.run('d-new', 'u1', 'terms', 'v2', 'sent', null, monthsAgo(now, 2));
  del.run('d-old', 'u3', 'terms', 'v2', 'failed', 'bounced a@b.c', yearsAgo(now, 8));
}

describe('legal evidence retention', () => {
  it('the classification declares the rule for both tables (a lost rule would delete or keep nothing)', () => {
    const plan = legalEvidenceRetentionPlan();
    expect(Object.keys(plan).sort()).toEqual(['legal_acceptances', 'legal_notice_deliveries']);
    expect(plan.legal_acceptances).toMatchObject({
      nullAfterMonths: 12,
      nullColumns: ['ip', 'user_agent'],
      deleteAfterYears: 7,
    });
  });

  it('NULLs ip + user agent after 12 months, keeps the fact, deletes past 7 years', async () => {
    const db = platform();
    seed(db);
    const r = await runLegalEvidenceRetention(now, runOn(db));
    expect(r.nulled.legal_acceptances).toBe(2); // mid (13 months) and old (8 years, nulled first, then deleted)
    expect(r.deleted).toEqual({ legal_acceptances: 1, legal_notice_deliveries: 1 });
    const rows = db
      .prepare('SELECT id, ip, user_agent, doc_key, version FROM legal_acceptances ORDER BY id')
      .all() as Record<string, unknown>[];
    expect(rows.map(x => x.id)).toEqual(['mid', 'new']);
    expect(rows.find(x => x.id === 'new')).toMatchObject({ ip: '1.1.1.1', user_agent: 'UA' }); // inside 12 months: untouched
    expect(rows.find(x => x.id === 'mid')).toMatchObject({
      ip: null,
      user_agent: null,
      doc_key: 'terms',
      version: 'v1',
    }); // fact kept
    expect(db.prepare('SELECT id FROM legal_notice_deliveries').all()).toEqual([{ id: 'd-new' }]);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const db = platform();
    seed(db);
    await runLegalEvidenceRetention(now, runOn(db));
    const again = await runLegalEvidenceRetention(now, runOn(db));
    expect(Object.values(again.nulled)).toEqual([0]);
    expect(Object.values(again.deleted)).toEqual([0, 0]);
  });

  it('month arithmetic clamps to the last day of the target month (no overflow past the window)', () => {
    const at = (y: number, m: number, d: number, h = 9) => Date.UTC(y, m - 1, d, h);
    expect(monthsAgo(at(2028, 2, 29), 12)).toBe(at(2027, 2, 28)); // 29 Feb - 1 year: 28 Feb, NOT 1 Mar
    expect(yearsAgo(at(2028, 2, 29), 7)).toBe(at(2021, 2, 28)); // 7 years back from a leap day
    expect(monthsAgo(at(2026, 3, 31), 1)).toBe(at(2026, 2, 28)); // 31 Mar - 1 month: 28 Feb, NOT 3 Mar
    expect(monthsAgo(at(2028, 3, 31), 1)).toBe(at(2028, 2, 29)); // leap February
    expect(monthsAgo(at(2026, 5, 31), 3)).toBe(at(2026, 2, 28));
    expect(monthsAgo(at(2026, 1, 15), 2)).toBe(at(2025, 11, 15)); // an ordinary day is unchanged, across a year boundary
    expect(monthsAgo(at(2026, 11, 24, 12), 12)).toBe(at(2025, 11, 24, 12)); // time of day kept
  });

  it('a row one day younger than the cutoff survives on a month-end run (the overflow would have deleted it)', async () => {
    const db = platform();
    const runNow = Date.UTC(2028, 1, 29, 12); // 29 Feb 2028
    // 12-month cutoff is 28 Feb 2027 12:00; a row accepted on 28 Feb 2027 18:00 is younger than 12 months and keeps its ip
    db.prepare(
      'INSERT INTO legal_acceptances (id, user_id, doc_key, version, accepted_at, ip, user_agent, source) VALUES (?,?,?,?,?,?,?,?)'
    ).run('edge', 'u9', 'terms', 'v1', Date.UTC(2027, 1, 28, 18), '9.9.9.9', 'UA', 'signup');
    await runLegalEvidenceRetention(runNow, runOn(db));
    expect(db.prepare('SELECT ip FROM legal_acceptances WHERE id = ?').get('edge')).toEqual({
      ip: '9.9.9.9',
    });
  });

  it('the delete window is never shorter than RETENTION_YEARS', () => {
    expect(RETENTION_YEARS).toBeGreaterThanOrEqual(7);
    expect(yearsAgo(now, 7)).toBeLessThan(monthsAgo(now, 83));
  });
});
