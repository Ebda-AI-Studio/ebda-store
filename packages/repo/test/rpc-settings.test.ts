/**
 * Ruling CF-WRITES-3: the settings copy accepts every field a routed `Store` write can carry. A relation write
 * (`credentials: { upsert }` on agent-key rotation) and the directory-only columns (plan, status, domain verification)
 * are reported as not stored, never a refusal; an unknown name is still refused.
 */
import { describe, expect, it } from 'vitest';
import { applyStoreSettings } from '../src/rpc/settings';
import { META, openSqlite } from './diff-harness';
import { nodeSqlRunner } from './node-sql';

function rig() {
  const db = openSqlite();
  const sql = nodeSqlRunner(db);
  db.prepare(
    `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES ('s1', 'n', 'n', 'o')`
  ).run();
  return { db, sql };
}

describe('applyStoreSettings', () => {
  it('reports a relation write as directory-only instead of refusing', () => {
    const { sql } = rig();
    const out = applyStoreSettings(sql, META as never, 's1', {
      agentApiKeyRotatedAt: new Date(0),
      credentials: { upsert: { create: { agentApiKey: 'x' }, update: { agentApiKey: 'x' } } },
    });
    expect(out.directoryOnly).toContain('credentials');
    expect(out.profile.concat(out.config)).toContain('agentApiKeyRotatedAt');
  });

  it('stores config fields and copies the mirror columns and reports domain verification as directory-only', () => {
    const { sql, db } = rig();
    const out = applyStoreSettings(sql, META as never, 's1', {
      taxEnabled: true,
      plan: 'professional',
      status: 'suspended',
      domainStatus: 'pending',
      pendingDomain: 'x.example.com',
    });
    expect(out.config).toContain('taxEnabled');
    expect(out.profile).toEqual(expect.arrayContaining(['plan', 'status']));
    expect(out.directoryOnly).toEqual(expect.arrayContaining(['domainStatus', 'pendingDomain']));
    const row = db.prepare('SELECT tax_enabled FROM store_config WHERE store_id = ?').get('s1') as {
      tax_enabled: number;
    };
    expect(row.tax_enabled).toBe(1);
  });

  it('still refuses an unknown field', () => {
    const { sql } = rig();
    expect(() => applyStoreSettings(sql, META as never, 's1', { nope: 1 })).toThrow(
      /unknown Store field/
    );
  });
});
