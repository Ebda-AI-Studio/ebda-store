// N-9 cutover: the Postgres -> StoreDO transforms round-trip through importRows / exportRowsPage with an EQUAL digest, the
// column lists the script sends equal the DO's IMPORT_COLUMNS, and a bad row / a live DO is refused.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import * as A from '../../packages/repo/src/do/customer-auth';
// @ts-expect-error plain .mjs without types
import { TABLES, digestRows, stableRows } from '../../scripts/cf/lib/customer-auth-copy.mjs';

const T = new Date('2026-10-01T10:00:00.000Z');
const pgUser = {
  id: 'u1',
  email: 'a@x.com',
  password_hash: '$2b$12$abc',
  first_name: 'A',
  last_name: 'B',
  phone: null,
  status: 'active',
  email_verified: true,
  avatar: null,
  date_of_birth: null,
  language: 'ar',
  last_login_at: T,
  created_at: T,
  updated_at: T,
  deleted_at: null,
  mfa_enabled: false,
  mfa_secret: null,
  mfa_backup_codes: [],
  mfa_enrolled_at: null,
  token_version: 3,
};
const pgRefresh = {
  id: 'r1',
  token: 'h'.repeat(64),
  user_id: 'u1',
  expires_at: new Date(T.getTime() + 1e9),
  created_at: T,
  replaced_by_id: null,
  revoked_at: null,
  revoked_reason: null,
};
const pgPasskey = {
  id: 'p1',
  user_id: 'u1',
  credential_id: 'cred',
  public_key: 'k',
  counter: 7n,
  transports: ['usb'],
  device_type: 'multiDevice',
  backed_up: true,
  rp_id: 'shop.example',
  name: 'phone',
  created_at: T,
  last_used_at: null,
};

describe('customer-auth cutover copy', () => {
  it('script columns equal the DO import columns, table by table', () => {
    for (const t of Object.keys(TABLES))
      expect(TABLES[t].cols).toEqual([...A.IMPORT_COLUMNS[t as keyof typeof A.IMPORT_COLUMNS]]);
  });
  it('round-trips with an equal count + digest, and the DO can then log the customer in / rotate', async () => {
    const db = nodeSyncSql(new DatabaseSync(':memory:'));
    A.ensureCustomerAuthSchema(db);
    const src: Record<string, unknown[][]> = {
      _cauth_users: [TABLES._cauth_users.map(pgUser)],
      _cauth_refresh: [TABLES._cauth_refresh.map(pgRefresh)],
      _cauth_passkeys: [TABLES._cauth_passkeys.map(pgPasskey)],
    };
    for (const [t, rows] of Object.entries(src))
      expect(A.importRows(db, { table: t, rows })).toMatchObject({ ok: true });
    for (const [t, rows] of Object.entries(src)) {
      const page = A.exportRowsPage(db, { table: t, after: null, limit: 1000 });
      if (!page.ok) throw new Error('export failed');
      expect(await digestRows(TABLES[t].cols, page.data.rows)).toEqual(
        await digestRows(TABLES[t].cols, rows)
      );
    }
    expect(A.loginRow(db, 'a@x.com')).toMatchObject({ id: 'u1', tokenVersion: 3 });
    expect(A.passkeyLookup(db, { credentialId: 'cred' })).toMatchObject({
      data: { passkey: { counter: 7, transports: ['usb'] } },
    });
    // the imported refresh token (sha256 hex) rotates exactly like a native one
    const r = A.rotateRefresh(
      db,
      {
        presentedHash: 'h'.repeat(64),
        newHash: 'n'.repeat(64),
        newRowId: 'r2',
        newExpiresAt: T.getTime() + 2e9,
      },
      T.getTime() + 1000
    );
    expect(r).toMatchObject({ ok: true, data: { user: { id: 'u1', tokenVersion: 3 } } });
  });
  it('a digest changes when any column changes; a live DO refuses imports', async () => {
    const a = await digestRows(TABLES._cauth_users.cols, [TABLES._cauth_users.map(pgUser)]);
    const b = await digestRows(TABLES._cauth_users.cols, [
      TABLES._cauth_users.map({ ...pgUser, token_version: 4 }),
    ]);
    expect(a.digest).not.toBe(b.digest);
    const db = nodeSyncSql(new DatabaseSync(':memory:'));
    A.ensureCustomerAuthSchema(db);
    A.markLive(db);
    expect(
      A.importRows(db, { table: '_cauth_users', rows: [TABLES._cauth_users.map(pgUser)] })
    ).toMatchObject({ ok: false, status: 423 });
  });
});

describe('drift check ignores the clock (stableRows)', () => {
  const day = 86_400_000;
  const refresh = (id: string, expires: number, revoked: number | null) => [
    id,
    't',
    'u1',
    expires,
    0,
    null,
    revoked,
    null,
  ];
  it('a token that expired during the run, or a revocation that aged out, is not drift', async () => {
    const cutoff = 1_800_000_000_000;
    const before = [
      refresh('a', cutoff + day, null), // still live
      refresh('b', cutoff - 5, null), // expired DURING the run
      refresh('c', cutoff + day, cutoff - 31 * day), // revocation aged out of the 30 day window
      refresh('d', cutoff + day, cutoff - 2 * day), // recently revoked: kept
    ];
    const after = [before[0], before[3]]; // what a fresh query returns at the check
    const cols = TABLES._cauth_refresh.cols;
    const a = await digestRows(cols, stableRows('_cauth_refresh', before, cutoff));
    const b = await digestRows(cols, stableRows('_cauth_refresh', after, cutoff));
    expect(a).toEqual(b);
    // but a REAL change inside the window still shows
    const tampered = [before[0], refresh('d', cutoff + day, null)];
    expect(await digestRows(cols, stableRows('_cauth_refresh', tampered, cutoff))).not.toEqual(a);
  });
  it('other tables are never reduced', () => {
    const rows = [[1], [2]];
    expect(stableRows('_cauth_users', rows, 0)).toBe(rows);
  });
});
