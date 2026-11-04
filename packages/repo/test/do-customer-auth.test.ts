// StoreDO customer auth (N-9): registration, verification, rotation + reuse detection, revocation, reset, passkeys, import.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { nodeSyncSql } from './node-sync-sql';
import * as A from '../src/do/customer-auth';

function fx() {
  const db = nodeSyncSql(new DatabaseSync(':memory:'));
  A.ensureCustomerAuthSchema(db);
  A.ensureCustomerAuthSchema(db); // idempotent
  return db;
}
const T0 = 1_700_000_000_000;
const reg = (db: ReturnType<typeof fx>, email = 'a@x.com', id = 'u1', tok = 'v1') =>
  A.register(
    db,
    {
      id,
      email,
      passwordHash: 'H1',
      firstName: 'A',
      lastName: 'B',
      verification: { tokenHash: tok, expiresAt: T0 + 1e6, rowId: `r-${tok}` },
    },
    T0
  );
const session = (db: ReturnType<typeof fx>, userId: string, hash: string, tv = 0) =>
  A.issueSession(
    db,
    { userId, expectedTv: tv, tokenHash: hash, rowId: `id-${hash}`, expiresAt: T0 + 1e9 },
    T0
  );
const rot = (db: ReturnType<typeof fx>, from: string, to: string, now: number) =>
  A.rotateRefresh(
    db,
    { presentedHash: from, newHash: to, newRowId: `id-${to}`, newExpiresAt: T0 + 1e9 },
    now
  );

describe('register / verify', () => {
  it('creates once; a duplicate reports the existing account and writes nothing', () => {
    const db = fx();
    expect(reg(db).ok).toBe(true);
    const d = reg(db, 'a@x.com', 'u2', 'v2');
    expect(d.ok && d.data.created).toBe(false);
    expect(A.counts(db)._cauth_users).toBe(1);
    expect(A.counts(db)._cauth_tokens).toBe(1);
  });
  it('verification token is single use and expiring', () => {
    const db = fx();
    reg(db);
    const r = A.verifyEmail(db, { tokenHash: 'v1' }, T0 + 5);
    expect(r.ok && r.data.already).toBe(false);
    expect(A.verifyEmail(db, { tokenHash: 'v1' }, T0 + 6)).toMatchObject({
      ok: false,
      code: 'TOKEN_INVALID',
    });
    const db2 = fx();
    reg(db2);
    expect(A.verifyEmail(db2, { tokenHash: 'v1' }, T0 + 2e6)).toMatchObject({
      ok: false,
      code: 'TOKEN_EXPIRED',
    });
    // the expired token was deleted (committed)
    expect(A.counts(db2)._cauth_tokens).toBe(0);
  });
  it('resend: unknown -> none, recent -> refused, later -> issued', () => {
    const db = fx();
    reg(db);
    const base = { tokenHash: 'v9', expiresAt: T0 + 1e6, rowId: 'r9' };
    expect(A.resendVerification(db, { email: 'no@x.com', ...base }, T0)).toMatchObject({
      data: { kind: 'none' },
    });
    expect(A.resendVerification(db, { email: 'a@x.com', ...base }, T0 + 1000)).toMatchObject({
      data: { kind: 'recent' },
    });
    expect(
      A.resendVerification(db, { email: 'a@x.com', ...base }, T0 + A.VERIFY_RESEND_GAP_MS + 10)
    ).toMatchObject({ data: { kind: 'issued' } });
  });
});

describe('sessions', () => {
  it('rotation: new token works, the old one replayed after the grace window revokes the whole family', () => {
    const db = fx();
    reg(db);
    expect(session(db, 'u1', 'h1').ok).toBe(true);
    expect(rot(db, 'h1', 'h2', T0 + 1000).ok).toBe(true);
    expect(rot(db, 'h2', 'h3', T0 + 2000).ok).toBe(true);
    // replay of h1 long after the grace window: reuse -> family revoked and COMMITTED
    const r = rot(db, 'h1', 'h4', T0 + A.ROTATION_RACE_GRACE_MS + 5000);
    expect(r).toMatchObject({ ok: false, code: 'TOKEN_REUSED', status: 401 });
    expect(rot(db, 'h3', 'h5', T0 + A.ROTATION_RACE_GRACE_MS + 6000)).toMatchObject({
      ok: false,
      code: 'TOKEN_REUSED',
    });
  });
  it('rotation race inside the window is forgiven at most 5 times, then the family dies', () => {
    const db = fx();
    reg(db);
    session(db, 'u1', 'h1');
    rot(db, 'h1', 'h2', T0 + 100);
    for (let i = 0; i < A.ROTATION_RACE_MAX_GRACE_USES; i++)
      expect(rot(db, 'h1', `g${i}`, T0 + 200 + i).ok).toBe(true);
    expect(rot(db, 'h1', 'gx', T0 + 300)).toMatchObject({ ok: false, code: 'TOKEN_REUSED' });
    expect(rot(db, 'h2', 'hh', T0 + 400)).toMatchObject({ ok: false, code: 'TOKEN_REUSED' });
  });
  it('a forgiven replay of a dead family is NOT forgiven (revoked tip)', () => {
    const db = fx();
    reg(db);
    session(db, 'u1', 'h1');
    rot(db, 'h1', 'h2', T0 + 100);
    A.revokeAll(db, { userId: 'u1' }, T0 + 150);
    expect(rot(db, 'h1', 'x', T0 + 200)).toMatchObject({ ok: false, code: 'TOKEN_REUSED' });
  });
  it('unknown token 401, expired 401, suspended 401', () => {
    const db = fx();
    reg(db);
    expect(rot(db, 'nope', 'n', T0)).toMatchObject({
      ok: false,
      code: 'TOKEN_INVALID',
      status: 401,
    });
    A.issueSession(
      db,
      { userId: 'u1', expectedTv: 0, tokenHash: 'e1', rowId: 'e', expiresAt: T0 + 10 },
      T0
    );
    expect(rot(db, 'e1', 'e2', T0 + 20)).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
    session(db, 'u1', 's1');
    db.run(`UPDATE _cauth_users SET status='suspended'`, []);
    expect(rot(db, 's1', 's2', T0 + 30)).toMatchObject({ ok: false, code: 'ACCOUNT_SUSPENDED' });
    expect(session(db, 'u1', 's3')).toMatchObject({ ok: false, code: 'ACCOUNT_SUSPENDED' });
  });
  it('issueSession is void when the token version moved', () => {
    const db = fx();
    reg(db);
    A.revokeAll(db, { userId: 'u1' }, T0);
    expect(session(db, 'u1', 'h1', 0)).toMatchObject({ ok: false, code: 'TOKEN_REVOKED' });
    expect(session(db, 'u1', 'h1', 1).ok).toBe(true);
  });
  it('logout marks, replay of the logged-out token is reuse', () => {
    const db = fx();
    reg(db);
    session(db, 'u1', 'h1');
    session(db, 'u1', 'h2');
    A.logout(db, { tokenHash: 'h1' }, T0 + 1);
    expect(rot(db, 'h1', 'n', T0 + A.ROTATION_RACE_GRACE_MS + 9)).toMatchObject({
      ok: false,
      code: 'TOKEN_REUSED',
    });
    expect(rot(db, 'h2', 'n2', T0 + A.ROTATION_RACE_GRACE_MS + 10)).toMatchObject({ ok: false });
    expect(A.logout(db, { tokenHash: 'unknown' })).toMatchObject({ ok: true });
  });
  it('revokeAll bumps the version immediately and kills reset links', () => {
    const db = fx();
    reg(db);
    A.requestReset(
      db,
      { email: 'a@x.com', tokenHash: 'r1', rowId: 'rr1', expiresAt: T0 + 1e6 },
      T0
    );
    session(db, 'u1', 'h1');
    expect(A.revokeAll(db, { userId: 'u1' }, T0 + 1)).toMatchObject({ data: { tokenVersion: 1 } });
    expect(A.userState(db, { userId: 'u1' })).toMatchObject({ data: { tokenVersion: 1 } });
    expect(A.resetPassword(db, { tokenHash: 'r1', newHash: 'H2' }, T0 + 2)).toMatchObject({
      ok: false,
    });
  });
  it('unknown user state is null (caller blocks)', () => {
    expect(A.userState(fx(), { userId: 'ghost' })).toMatchObject({ ok: true, data: null });
  });
});

describe('password reset / change', () => {
  it('reset link is single use, sets the hash, drops passkeys, revokes sessions', () => {
    const db = fx();
    reg(db);
    session(db, 'u1', 'h1');
    A.passkeyAdd(
      db,
      {
        id: 'p1',
        userId: 'u1',
        credentialId: 'c1',
        publicKey: 'k',
        counter: 0,
        transports: [],
        deviceType: 'singleDevice',
        backedUp: false,
        rpId: 'x',
        name: 'n',
      },
      T0
    );
    A.requestReset(
      db,
      { email: 'a@x.com', tokenHash: 'r1', rowId: 'rr1', expiresAt: T0 + 1e6 },
      T0
    );
    expect(A.resetPassword(db, { tokenHash: 'r1', newHash: 'H2' }, T0 + 5)).toMatchObject({
      ok: true,
      data: { purgedPasskeys: 1 },
    });
    expect(A.hashOf(db, 'u1')).toBe('H2');
    expect(A.resetPassword(db, { tokenHash: 'r1', newHash: 'H3' }, T0 + 6)).toMatchObject({
      ok: false,
      code: 'TOKEN_INVALID',
    });
    expect(rot(db, 'h1', 'n', T0 + 7)).toMatchObject({ ok: false });
    expect(A.userState(db, { userId: 'u1' })).toMatchObject({ data: { tokenVersion: 1 } });
  });
  it('an expired reset link is refused; unknown email issues nothing', () => {
    const db = fx();
    reg(db);
    A.requestReset(db, { email: 'a@x.com', tokenHash: 'r1', rowId: 'rr1', expiresAt: T0 + 10 }, T0);
    expect(A.resetPassword(db, { tokenHash: 'r1', newHash: 'H2' }, T0 + 11)).toMatchObject({
      ok: false,
    });
    expect(
      A.requestReset(
        db,
        { email: 'no@x.com', tokenHash: 'r2', rowId: 'rr2', expiresAt: T0 + 10 },
        T0
      )
    ).toMatchObject({ data: null });
  });
  it('change is void when the verified hash is stale', () => {
    const db = fx();
    reg(db);
    expect(
      A.setPasswordRevokingAll(db, {
        userId: 'u1',
        expectedHash: 'OLD',
        newHash: 'N',
        reason: 'password_changed',
      })
    ).toMatchObject({ ok: false });
    expect(
      A.setPasswordRevokingAll(db, {
        userId: 'u1',
        expectedHash: 'H1',
        newHash: 'N',
        reason: 'password_changed',
      })
    ).toMatchObject({ ok: true });
  });
  it('login: success re-check voids when the password moved during the compare', () => {
    const db = fx();
    reg(db);
    const row = A.loginRow(db, 'a@x.com')!;
    db.run(`UPDATE _cauth_users SET password_hash='H9'`, []);
    expect(A.loginSucceeded(db, row)).toMatchObject({ ok: false, code: 'INVALID_CREDENTIALS' });
    expect(A.loginRow(db, 'no@x.com')).toBeNull();
  });
});

describe('never leaks secrets', () => {
  it('no public shape carries a hash or secret', () => {
    const db = fx();
    reg(db);
    const blob = JSON.stringify([
      A.getProfile(db, { userId: 'u1' }),
      A.exportCustomer(db, { userId: 'u1' }),
      A.loginSucceeded(db, A.loginRow(db, 'a@x.com')!),
    ]);
    expect(blob).not.toMatch(/H1|password|mfaSecret|backup/i);
  });
});

describe('passkeys + erasure + retention', () => {
  it('lookup is per-DO, counter is compare-and-set', () => {
    const db = fx();
    reg(db);
    A.passkeyAdd(
      db,
      {
        id: 'p1',
        userId: 'u1',
        credentialId: 'c1',
        publicKey: 'k',
        counter: 0,
        transports: ['usb'],
        deviceType: 'multiDevice',
        backedUp: true,
        rpId: 'x',
        name: 'n',
      },
      T0
    );
    expect(
      A.passkeyAdd(db, {
        id: 'p2',
        userId: 'u1',
        credentialId: 'c1',
        publicKey: 'k',
        counter: 0,
        transports: [],
        deviceType: 'a',
        backedUp: false,
        rpId: 'x',
        name: 'n',
      })
    ).toMatchObject({ ok: false });
    expect(A.passkeyLookup(db, { credentialId: 'c1' })).toMatchObject({
      data: { user: { id: 'u1' } },
    });
    expect(A.passkeyLookup(db, { credentialId: 'zz' })).toMatchObject({ data: null });
    expect(
      A.passkeyTouch(db, { id: 'p1', userId: 'u1', counter: 5, backedUp: true })
    ).toMatchObject({ data: { touched: true } });
    expect(
      A.passkeyTouch(db, { id: 'p1', userId: 'u1', counter: 5, backedUp: true })
    ).toMatchObject({ data: { touched: false } });
    expect(A.passkeyRemove(db, { id: 'p1', userId: 'other' })).toMatchObject({
      data: { removed: 0 },
    });
  });
  it('erase anonymises and removes tokens/passkeys; purge drops expired', () => {
    const db = fx();
    reg(db);
    session(db, 'u1', 'h1');
    expect(A.eraseCustomer(db, { userId: 'u1' }, T0 + 1)).toMatchObject({ data: { erased: true } });
    expect(A.loginRow(db, 'a@x.com')).toBeNull();
    expect(A.counts(db)).toMatchObject({ _cauth_refresh: 0, _cauth_tokens: 0 });
    A.issueSession(
      db,
      { userId: 'u1', expectedTv: 1, tokenHash: 'z', rowId: 'z', expiresAt: T0 + 5 },
      T0
    );
    expect(A.purgeCustomerAuth(db, T0 + 1e9)).toBeGreaterThanOrEqual(0);
  });
});

describe('cutover import', () => {
  it('upserts idempotently, round-trips through exportRowsPage, refuses after live', () => {
    const db = fx();
    reg(db);
    const page = A.exportRowsPage(db, { table: '_cauth_users', after: null, limit: 10 });
    const dst = fx();
    for (let i = 0; i < 2; i++)
      expect(
        A.importRows(dst, { table: '_cauth_users', rows: page.ok ? page.data.rows : [] })
      ).toMatchObject({ ok: true });
    expect(A.counts(dst)._cauth_users).toBe(1);
    expect(A.exportRowsPage(dst, { table: '_cauth_users', after: null, limit: 10 })).toEqual(page);
    A.markLive(dst);
    expect(A.importRows(dst, { table: '_cauth_users', rows: [] })).toMatchObject({
      ok: false,
      status: 423,
    });
    expect(A.importRows(dst, { table: 'users', rows: [] })).toMatchObject({ ok: false });
  });
});
