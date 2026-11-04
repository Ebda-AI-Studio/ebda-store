import type { SyncSql } from './sync-sql';

/**
 * Storefront CUSTOMER authentication on the StoreDO (NEON-ZERO-1 N-9, Ruling NZ-A3). One DO = one store, so every row here
 * belongs to the store this DO serves: a customer of store A does not exist in store B's DO, which is the whole isolation.
 *
 * Tables (internal, `_cauth_` prefix: excluded from the R2 backup, the PDPL export and the erasure registry by design, so a
 * password hash or a token hash can never leave through those paths; recovery is DO point-in-time restore, erasure is
 * `eraseCustomer`):
 *   _cauth_users    credentials + profile + token_version (the revocation authority) + status
 *   _cauth_refresh  refresh tokens, stored as sha256, with rotation links and reuse-detection fields
 *   _cauth_tokens   email-verification and password-reset tokens, stored as sha256, single use, expiring
 *   _cauth_passkeys WebAuthn credentials (PUBLIC key only)
 *   _cauth_state    the import's live flag (`live`): once set, the cutover import is refused
 *
 * Every function here is ONE synchronous section (`db.transactionSync`, no await inside). Refusals are RETURNED as
 * `{ ok:false }` (not thrown) because several of them must COMMIT a write first (reuse detection revokes the whole family
 * and still answers 401). Password hashing is the caller's job EXCEPT the verify step (`verifyPassword`), which runs inside
 * the DO so a hash never crosses the RPC boundary.
 */

export type Refusal = { ok: false; code: string; status: number; message: string };
export type Ok<T> = { ok: true; data: T };
export type Res<T> = Ok<T> | Refusal;

const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
const no = (code: string, status: number, message = code): Refusal => ({
  ok: false,
  code,
  status,
  message,
});

export const CAUTH_TABLES = [
  '_cauth_users',
  '_cauth_refresh',
  '_cauth_tokens',
  '_cauth_passkeys',
] as const;

const DDL = [
  `CREATE TABLE IF NOT EXISTS _cauth_users (
     id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL,
     first_name TEXT NOT NULL, last_name TEXT NOT NULL, phone TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
     email_verified INTEGER NOT NULL DEFAULT 0, avatar TEXT, date_of_birth INTEGER,
     language TEXT NOT NULL DEFAULT 'en', last_login_at INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
     mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_secret TEXT, mfa_backup_codes TEXT NOT NULL DEFAULT '[]',
     mfa_enrolled_at INTEGER, token_version INTEGER NOT NULL DEFAULT 0, erased_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS _cauth_users_email ON _cauth_users (email)`,
  `CREATE TABLE IF NOT EXISTS _cauth_refresh (
     id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
     replaced_by_id TEXT, revoked_at INTEGER, revoked_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS _cauth_refresh_user ON _cauth_refresh (user_id)`,
  `CREATE INDEX IF NOT EXISTS _cauth_refresh_exp ON _cauth_refresh (expires_at)`,
  `CREATE TABLE IF NOT EXISTS _cauth_tokens (
     id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('email','password_reset','two_factor')),
     expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS _cauth_tokens_user ON _cauth_tokens (user_id, type)`,
  `CREATE TABLE IF NOT EXISTS _cauth_passkeys (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE,
     public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]',
     device_type TEXT NOT NULL, backed_up INTEGER NOT NULL DEFAULT 0, rp_id TEXT NOT NULL, name TEXT NOT NULL,
     created_at INTEGER NOT NULL, last_used_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS _cauth_passkeys_user ON _cauth_passkeys (user_id)`,
  `CREATE TABLE IF NOT EXISTS _cauth_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

export function ensureCustomerAuthSchema(db: SyncSql): void {
  for (const s of DDL) db.run(s, []);
}

// ---- constants (parity with apps/api/src/services/auth.service.ts) ------------------------------------------------------
/** A rotated refresh row may be presented again for this long (two tabs refreshing together) ... */
export const ROTATION_RACE_GRACE_MS = 30_000;
/** ... at most this many times, and only while the family is still alive. */
export const ROTATION_RACE_MAX_GRACE_USES = 5;
const ROTATION_RACE_MAX_CHAIN_HOPS = 10;
const REASON_ROTATED = 'rotated';
const REASON_GRACE_PREFIX = 'rotated_grace_';
/** A second verification mail within this window is refused (429), as before. */
export const VERIFY_RESEND_GAP_MS = 2 * 60 * 1000;
/** Outstanding password-reset links per customer; the oldest beyond this are deleted. */
const MAX_RESET_LINKS = 5;
/** Retention of revoked refresh rows (reuse detection only needs them while a thief could still hold one). */
export const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;
const one = (db: SyncSql, sql: string, p: unknown[] = []): Row | undefined => db.all(sql, p)[0];
const bool = (v: unknown) => Number(v) === 1;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** What a caller may see of an account: NEVER the password hash, the MFA secret or the backup codes. */
export interface CustomerPublic {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: 'customer';
  status: string;
  emailVerified: boolean;
  avatar: string | null;
  dateOfBirth: number | null;
  language: string;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  mfaEnabled: boolean;
  mfaEnrolledAt: number | null;
  tokenVersion: number;
}

export function toPublic(r: Row): CustomerPublic {
  return {
    id: r.id as string,
    email: r.email as string,
    firstName: r.first_name as string,
    lastName: r.last_name as string,
    phone: (r.phone as string | null) ?? null,
    role: 'customer',
    status: r.status as string,
    emailVerified: bool(r.email_verified),
    avatar: (r.avatar as string | null) ?? null,
    dateOfBirth: num(r.date_of_birth),
    language: r.language as string,
    lastLoginAt: num(r.last_login_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    deletedAt: num(r.deleted_at),
    mfaEnabled: bool(r.mfa_enabled),
    mfaEnrolledAt: num(r.mfa_enrolled_at),
    tokenVersion: Number(r.token_version),
  };
}

const PUBLIC_COLS =
  'id, email, first_name, last_name, phone, status, email_verified, avatar, date_of_birth, language, last_login_at, created_at, updated_at, deleted_at, mfa_enabled, mfa_enrolled_at, token_version';

const userById = (db: SyncSql, id: string): Row | undefined =>
  one(db, `SELECT ${PUBLIC_COLS} FROM _cauth_users WHERE id = ?`, [id]);

const str = (v: unknown, max = 256): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

/** Revoke every live refresh row of a user. Returns the count. */
function revokeLive(db: SyncSql, userId: string, reason: string, now: number): number {
  return db.run(
    `UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL`,
    [now, reason, userId]
  ).changes;
}

// ---- register / verify --------------------------------------------------------------------------------------------------
export interface RegisterIn {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  language?: string;
  /** sha256 of the verification token and its expiry, written in the SAME section as the account. */
  verification: { tokenHash: string; expiresAt: number; rowId: string };
}

/** Create the account, or report the existing one (the caller sends the duplicate-registration notice). */
export function register(
  db: SyncSql,
  a: RegisterIn,
  now = Date.now()
): Res<
  | { created: true; user: CustomerPublic }
  | {
      created: false;
      existing: { email: string; firstName: string; lastName: string; language: string };
    }
> {
  const email = str(a.email, 320);
  if (!email || !str(a.passwordHash, 200) || !str(a.id, 128))
    return no('VALIDATION_ERROR', 400, 'invalid registration');
  return db.transactionSync(() => {
    const ex = one(
      db,
      `SELECT email, first_name, last_name, language FROM _cauth_users WHERE email = ?`,
      [email]
    );
    if (ex)
      return ok({
        created: false as const,
        existing: {
          email: ex.email as string,
          firstName: ex.first_name as string,
          lastName: ex.last_name as string,
          language: ex.language as string,
        },
      });
    db.run(
      `INSERT INTO _cauth_users (id, email, password_hash, first_name, last_name, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id,
        email,
        a.passwordHash,
        a.firstName ?? '',
        a.lastName ?? '',
        a.language === 'ar' ? 'ar' : 'en',
        now,
        now,
      ]
    );
    db.run(
      `INSERT INTO _cauth_tokens (id, token, user_id, type, expires_at, created_at) VALUES (?, ?, ?, 'email', ?, ?)`,
      [a.verification.rowId, a.verification.tokenHash, a.id, a.verification.expiresAt, now]
    );
    return ok({ created: true as const, user: toPublic(userById(db, a.id)!) });
  });
}

/** Redeem an email-verification token: single use, expiring. */
export function verifyEmail(
  db: SyncSql,
  a: { tokenHash: string },
  now = Date.now()
): Res<{
  already: boolean;
  user: Pick<CustomerPublic, 'id' | 'email' | 'firstName' | 'lastName' | 'language'>;
}> {
  return db.transactionSync(() => {
    const t = one(
      db,
      `SELECT id, user_id, expires_at FROM _cauth_tokens WHERE token = ? AND type = 'email' AND used_at IS NULL`,
      [a.tokenHash]
    );
    if (!t) return no('TOKEN_INVALID', 400, 'Invalid verification token');
    const u = userById(db, t.user_id as string);
    if (!u) return no('TOKEN_INVALID', 400, 'Invalid verification token');
    if (Number(t.expires_at) < now) {
      db.run(`DELETE FROM _cauth_tokens WHERE id = ?`, [t.id]);
      // the delete must commit even though the answer is a refusal: this function returns, it does not throw
      return no('TOKEN_EXPIRED', 400, 'Verification token has expired. Please request a new one.');
    }
    const mini = {
      id: u.id as string,
      email: u.email as string,
      firstName: u.first_name as string,
      lastName: u.last_name as string,
      language: u.language as string,
    };
    if (bool(u.email_verified)) return ok({ already: true, user: mini });
    // claim by row count: two concurrent redemptions cannot both succeed (and a DO runs them one at a time anyway)
    const claimed = db.run(
      `UPDATE _cauth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
      [now, t.id]
    );
    if (claimed.changes !== 1) return no('TOKEN_INVALID', 400, 'Invalid verification token');
    db.run(`UPDATE _cauth_users SET email_verified = 1, updated_at = ? WHERE id = ?`, [
      now,
      mini.id,
    ]);
    return ok({ already: false, user: mini });
  });
}

/** Resend: one atomic decision (none / verified / too soon / issued). Unknown email is `none`, never an error. */
export function resendVerification(
  db: SyncSql,
  a: { email: string; tokenHash: string; expiresAt: number; rowId: string },
  now = Date.now()
): Res<
  | { kind: 'none' }
  | { kind: 'verified' }
  | { kind: 'recent' }
  | {
      kind: 'issued';
      user: Pick<CustomerPublic, 'id' | 'email' | 'firstName' | 'lastName' | 'language'>;
    }
> {
  return db.transactionSync(() => {
    const u = one(db, `SELECT ${PUBLIC_COLS} FROM _cauth_users WHERE email = ?`, [a.email]);
    if (!u) return ok({ kind: 'none' as const });
    if (bool(u.email_verified)) return ok({ kind: 'verified' as const });
    const recent = one(
      db,
      `SELECT 1 AS x FROM _cauth_tokens WHERE user_id = ? AND type = 'email' AND created_at > ?`,
      [u.id, now - VERIFY_RESEND_GAP_MS]
    );
    if (recent) return ok({ kind: 'recent' as const });
    db.run(`DELETE FROM _cauth_tokens WHERE user_id = ? AND type = 'email'`, [u.id]);
    db.run(
      `INSERT INTO _cauth_tokens (id, token, user_id, type, expires_at, created_at) VALUES (?, ?, ?, 'email', ?, ?)`,
      [a.rowId, a.tokenHash, u.id, a.expiresAt, now]
    );
    return ok({
      kind: 'issued' as const,
      user: {
        id: u.id as string,
        email: u.email as string,
        firstName: u.first_name as string,
        lastName: u.last_name as string,
        language: u.language as string,
      },
    });
  });
}

// ---- login --------------------------------------------------------------------------------------------------------------
/** The hash for the login compare, read by the DO itself and NEVER returned over RPC. */
export function loginRow(
  db: SyncSql,
  email: string
): { id: string; hash: string; tokenVersion: number } | null {
  const r = one(
    db,
    `SELECT id, password_hash, token_version FROM _cauth_users WHERE email = ? AND deleted_at IS NULL`,
    [email]
  );
  return r
    ? { id: r.id as string, hash: r.password_hash as string, tokenVersion: Number(r.token_version) }
    : null;
}

/**
 * Credential for the Worker's password compare (Ruling NZ-N9-2, revised after the Opus review): bcrypt cost 12 costs ~250 ms of
 * CPU, which inside the single-threaded store DO would let a distributed login flood starve that store's checkout / stock /
 * orders. The compare therefore runs in the API Worker (which scales out), and the DO only hands the hash to that Worker over the
 * internal DO stub. NOT on the cutover channel's allow-list, never returned to a browser.
 */
export function credential(
  db: SyncSql,
  a: { email: string }
): Res<{ id: string; hash: string; tokenVersion: number } | null> {
  return ok(loginRow(db, String(a.email)));
}

export function credentialById(
  db: SyncSql,
  a: { userId: string }
): Res<{ id: string; hash: string } | null> {
  const hash = hashOf(db, String(a.userId));
  return ok(hash ? { id: a.userId, hash } : null);
}

/**
 * Called after the compare said yes. Re-reads the row: if the password or the token version moved while the compare
 * ran (a reset or a revoke landed), the success is void. Stamps last_login_at and returns the account.
 */
export function loginSucceeded(
  db: SyncSql,
  a: { id: string; hash: string; tokenVersion: number },
  now = Date.now()
): Res<{ user: CustomerPublic; mfa: boolean }> {
  return db.transactionSync(() => {
    const r = one(
      db,
      `SELECT password_hash, token_version, deleted_at, mfa_enabled, mfa_secret FROM _cauth_users WHERE id = ?`,
      [a.id]
    );
    if (
      !r ||
      r.deleted_at !== null ||
      r.password_hash !== a.hash ||
      Number(r.token_version) !== a.tokenVersion
    )
      return no('INVALID_CREDENTIALS', 401, 'Invalid email or password');
    db.run(`UPDATE _cauth_users SET last_login_at = ? WHERE id = ?`, [now, a.id]);
    return ok({ user: toPublic(userById(db, a.id)!), mfa: bool(r.mfa_enabled) && !!r.mfa_secret });
  });
}

/** Mint the refresh row of a session. Void if the account is not active or its token version moved since the login check. */
export function issueSession(
  db: SyncSql,
  a: { userId: string; expectedTv: number; tokenHash: string; rowId: string; expiresAt: number },
  now = Date.now()
): Res<CustomerPublic> {
  return db.transactionSync(() => {
    const u = userById(db, a.userId);
    if (!u) return no('TOKEN_INVALID', 401, 'Invalid refresh token');
    if (u.status !== 'active' || u.deleted_at !== null)
      return no('ACCOUNT_SUSPENDED', 403, 'This account is not active');
    if (Number(u.token_version) !== a.expectedTv)
      return no('TOKEN_REVOKED', 401, 'Session was revoked - please sign in again');
    db.run(
      `INSERT INTO _cauth_refresh (id, token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [a.rowId, a.tokenHash, a.userId, a.expiresAt, now]
    );
    return ok(toPublic(u));
  });
}

// ---- refresh (rotation + reuse detection) ---------------------------------------------------------------------------------
function endedByRotation(reason: unknown): boolean {
  return (
    reason === REASON_ROTATED ||
    (typeof reason === 'string' && reason.startsWith(REASON_GRACE_PREFIX))
  );
}
function graceUsesSpent(reason: unknown): number {
  if (typeof reason !== 'string' || !reason.startsWith(REASON_GRACE_PREFIX)) return 0;
  const n = Number.parseInt(reason.slice(REASON_GRACE_PREFIX.length), 10);
  return Number.isInteger(n) && n > 0 ? n : ROTATION_RACE_MAX_GRACE_USES; // unparseable reads as exhausted
}

/** Follow replaced_by_id from a rotated row to the tip of its family; true when the tip is still live. */
function successorChainIsLive(db: SyncSql, firstId: string, userId: string): boolean {
  let cursor: string | null = firstId;
  const seen = new Set<string>();
  for (let hop = 0; hop < ROTATION_RACE_MAX_CHAIN_HOPS; hop++) {
    if (cursor === null || seen.has(cursor)) return false;
    seen.add(cursor);
    const r = one(
      db,
      `SELECT revoked_at, revoked_reason, replaced_by_id FROM _cauth_refresh WHERE id = ? AND user_id = ?`,
      [cursor, userId]
    );
    if (!r) return false;
    if (r.revoked_at === null) return true;
    if (!endedByRotation(r.revoked_reason)) return false;
    cursor = (r.replaced_by_id as string | null) ?? null;
  }
  return false;
}

export interface RotateIn {
  presentedHash: string;
  newHash: string;
  newRowId: string;
  newExpiresAt: number;
}

/**
 * Rotate one presented refresh token. The whole decision is one section: lookup, reuse detection (revokes the family and
 * COMMITS that, then answers TOKEN_REUSED), the bounded rotation-race forgiveness, status checks, the new row, marking the
 * old one rotated. There is no window between the liveness check and the write for a revoke-all to slip through (the DO
 * runs one section at a time), so the post-write token-version re-read the Postgres path needed has no equivalent here.
 */
export function rotateRefresh(
  db: SyncSql,
  a: RotateIn,
  now = Date.now()
): Res<{ user: Pick<CustomerPublic, 'id' | 'email' | 'role' | 'tokenVersion'> }> {
  return db.transactionSync(() => {
    const row = one(db, `SELECT * FROM _cauth_refresh WHERE token = ?`, [a.presentedHash]);
    if (!row) return no('TOKEN_INVALID', 401, 'Invalid refresh token');
    const userId = row.user_id as string;
    const u = userById(db, userId);
    if (!u) return no('TOKEN_INVALID', 401, 'Invalid refresh token');

    const revokedAt = num(row.revoked_at);
    if (revokedAt !== null) {
      let forgiven = false;
      if (
        endedByRotation(row.revoked_reason) &&
        row.replaced_by_id !== null &&
        now - revokedAt <= ROTATION_RACE_GRACE_MS &&
        successorChainIsLive(db, row.replaced_by_id as string, userId)
      ) {
        const spent = graceUsesSpent(row.revoked_reason);
        if (spent < ROTATION_RACE_MAX_GRACE_USES) {
          db.run(`UPDATE _cauth_refresh SET revoked_reason = ? WHERE id = ?`, [
            `${REASON_GRACE_PREFIX}${spent + 1}`,
            row.id,
          ]);
          forgiven = true;
        }
      }
      if (!forgiven) {
        revokeLive(db, userId, 'reuse_detected', now);
        return no('TOKEN_REUSED', 401, 'Token reuse detected - please sign in again');
      }
    }

    if (Number(row.expires_at) < now) {
      db.run(`UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = 'expired' WHERE id = ?`, [
        now,
        row.id,
      ]);
      return no('TOKEN_EXPIRED', 401, 'Refresh token expired');
    }
    if (u.deleted_at !== null) {
      db.run(
        `UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = 'account_deleted' WHERE id = ?`,
        [now, row.id]
      );
      return no('ACCOUNT_DELETED', 401, 'Account has been deleted');
    }
    if (u.status !== 'active') {
      db.run(
        `UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = 'account_suspended' WHERE id = ?`,
        [now, row.id]
      );
      return no('ACCOUNT_SUSPENDED', 401, 'Account is not active');
    }

    // a forgiven replay gets back what was left of the presented token's life, never a fresh year
    const expiresAt =
      revokedAt !== null ? Math.min(Number(row.expires_at), a.newExpiresAt) : a.newExpiresAt;
    db.run(
      `INSERT INTO _cauth_refresh (id, token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [a.newRowId, a.newHash, userId, expiresAt, now]
    );
    if (revokedAt === null)
      db.run(
        `UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = ?, replaced_by_id = ? WHERE id = ? AND revoked_at IS NULL`,
        [now, REASON_ROTATED, a.newRowId, row.id]
      );
    return ok({
      user: {
        id: u.id as string,
        email: u.email as string,
        role: 'customer' as const,
        tokenVersion: Number(u.token_version),
      },
    });
  });
}

/** Logout: mark (never delete) so a replay of the same token still trips reuse detection. Unknown token is a no-op. */
export function logout(
  db: SyncSql,
  a: { tokenHash: string },
  now = Date.now()
): Res<{ revoked: number }> {
  return ok({
    revoked: db.run(
      `UPDATE _cauth_refresh SET revoked_at = ?, revoked_reason = 'logout' WHERE token = ? AND revoked_at IS NULL`,
      [now, a.tokenHash]
    ).changes,
  });
}

// ---- state / profile ----------------------------------------------------------------------------------------------------
/** Token version + status for the authenticate middleware. null = unknown user = BLOCKED by the caller. */
export function userState(
  db: SyncSql,
  a: { userId: string }
): Res<{ tokenVersion: number; status: string; deletedAt: number | null } | null> {
  const r = one(db, `SELECT token_version, status, deleted_at FROM _cauth_users WHERE id = ?`, [
    a.userId,
  ]);
  return ok(
    r
      ? {
          tokenVersion: Number(r.token_version),
          status: r.status as string,
          deletedAt: num(r.deleted_at),
        }
      : null
  );
}

export function getProfile(db: SyncSql, a: { userId: string }): Res<CustomerPublic | null> {
  const r = userById(db, a.userId);
  return ok(r ? toPublic(r) : null);
}

/** Public rows for many ids (<= 500): the directory read the merchant admin, orders, emails and eligibility checks use. */
export function profiles(db: SyncSql, a: { ids: string[] }): Res<CustomerPublic[]> {
  const ids = [...new Set((a.ids ?? []).filter(x => typeof x === 'string'))].slice(0, 500);
  if (ids.length === 0) return ok([]);
  return ok(
    db
      .all(
        `SELECT ${PUBLIC_COLS} FROM _cauth_users WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      )
      .map(toPublic)
  );
}

/** Newest registered, not-deleted customers (the admin "registered but never ordered" union), optionally within `ids`. */
export function newest(db: SyncSql, a: { limit: number; ids?: string[] }): Res<CustomerPublic[]> {
  const limit = Math.min(Math.max(1, a.limit | 0), 5000);
  if (a.ids) {
    const ids = a.ids.slice(0, 500);
    if (ids.length === 0) return ok([]);
    return ok(
      db
        .all(
          `SELECT ${PUBLIC_COLS} FROM _cauth_users WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`,
          [...ids, limit]
        )
        .map(toPublic)
    );
  }
  return ok(
    db
      .all(
        `SELECT ${PUBLIC_COLS} FROM _cauth_users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
        [limit]
      )
      .map(toPublic)
  );
}

/** Soft-deleted accounts past the retention cutoff that are not yet anonymised (the retention cron's candidates). */
export function expiredDeleted(db: SyncSql, a: { before: number; limit: number }): Res<string[]> {
  return ok(
    db
      .all(
        `SELECT id FROM _cauth_users WHERE deleted_at IS NOT NULL AND deleted_at < ? AND erased_at IS NULL LIMIT ?`,
        [a.before, Math.min(Math.max(1, a.limit | 0), 1000)]
      )
      .map(r => r.id as string)
  );
}

export function updateProfile(
  db: SyncSql,
  a: { userId: string; firstName?: string; lastName?: string; phone?: string },
  now = Date.now()
): Res<{ user: CustomerPublic; previousPhone: string | null }> {
  return db.transactionSync(() => {
    const before = userById(db, a.userId);
    if (!before) return no('NOT_FOUND', 404, 'User not found');
    const sets: string[] = [];
    const p: unknown[] = [];
    if (a.firstName !== undefined) (sets.push('first_name = ?'), p.push(a.firstName));
    if (a.lastName !== undefined) (sets.push('last_name = ?'), p.push(a.lastName));
    if (a.phone !== undefined) (sets.push('phone = ?'), p.push(a.phone));
    if (sets.length)
      db.run(`UPDATE _cauth_users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [
        ...p,
        now,
        a.userId,
      ]);
    return ok({
      user: toPublic(userById(db, a.userId)!),
      previousPhone: (before.phone as string | null) ?? null,
    });
  });
}

// ---- revocation / password -----------------------------------------------------------------------------------------------
export type RevokeReason = 'revoke_all' | 'password_changed' | 'password_reset';

function revokeAllIn(db: SyncSql, userId: string, reason: string, now: number): number {
  db.run(`UPDATE _cauth_users SET token_version = token_version + 1, updated_at = ? WHERE id = ?`, [
    now,
    userId,
  ]);
  revokeLive(db, userId, reason, now);
  db.run(`DELETE FROM _cauth_tokens WHERE user_id = ? AND type = 'password_reset'`, [userId]);
  return Number(
    one(db, `SELECT token_version FROM _cauth_users WHERE id = ?`, [userId])!.token_version
  );
}

/** Bump the token version, revoke every live refresh row and every outstanding reset link: IMMEDIATE revocation. */
export function revokeAll(
  db: SyncSql,
  a: { userId: string; reason?: RevokeReason },
  now = Date.now()
): Res<{ tokenVersion: number }> {
  return db.transactionSync(() => {
    if (!userById(db, a.userId)) return no('NOT_FOUND', 404, 'User not found');
    return ok({ tokenVersion: revokeAllIn(db, a.userId, a.reason ?? 'revoke_all', now) });
  });
}

/**
 * Operator / merchant status change (suspend, deactivate, reactivate) in ONE section: the status, the token-version bump and
 * the revocation of every live refresh row and reset link. A status that leaves `active` therefore kills the sessions NOW
 * (access tokens on the next request via the version, refresh tokens at once), never "status recorded, sessions alive".
 */
export function setStatus(
  db: SyncSql,
  a: { userId: string; status: 'active' | 'inactive' | 'suspended' },
  now = Date.now()
): Res<{ tokenVersion: number; previous: string }> {
  if (!['active', 'inactive', 'suspended'].includes(a.status))
    return no('VALIDATION_ERROR', 400, 'bad status');
  return db.transactionSync(() => {
    const u = one(db, `SELECT status FROM _cauth_users WHERE id = ?`, [a.userId]);
    if (!u) return no('NOT_FOUND', 404, 'User not found');
    db.run(`UPDATE _cauth_users SET status = ?, updated_at = ? WHERE id = ?`, [
      a.status,
      now,
      a.userId,
    ]);
    // leaving active (or any change) bumps and revokes; reactivation also bumps so a token minted before the suspension stays dead
    const tokenVersion = revokeAllIn(
      db,
      a.userId,
      a.status === 'active' ? 'revoke_all' : 'account_suspended',
      now
    );
    return ok({ tokenVersion, previous: u.status as string });
  });
}

/** Sync half of changePassword, after the DO verified the current password (`verifyPassword`). One section: new hash + every passkey gone + revoke all. */
export function setPasswordRevokingAll(
  db: SyncSql,
  a: {
    userId: string;
    expectedHash: string;
    newHash: string;
    reason: 'password_changed' | 'password_reset';
  },
  now = Date.now()
): Res<{
  tokenVersion: number;
  purgedPasskeys: number;
  user: Pick<CustomerPublic, 'id' | 'email' | 'firstName' | 'language'>;
}> {
  return db.transactionSync(() => {
    const u = one(
      db,
      `SELECT id, email, first_name, language, password_hash FROM _cauth_users WHERE id = ?`,
      [a.userId]
    );
    if (!u) return no('NOT_FOUND', 404, 'User not found');
    // the password moved while the (async) compare ran: the verified one is stale
    if (u.password_hash !== a.expectedHash)
      return no('INVALID_PASSWORD', 400, 'Current password is incorrect');
    db.run(`UPDATE _cauth_users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
      a.newHash,
      now,
      a.userId,
    ]);
    const purged = db.run(`DELETE FROM _cauth_passkeys WHERE user_id = ?`, [a.userId]).changes;
    const tokenVersion = revokeAllIn(db, a.userId, a.reason, now);
    return ok({
      tokenVersion,
      purgedPasskeys: purged,
      user: {
        id: u.id as string,
        email: u.email as string,
        firstName: u.first_name as string,
        language: u.language as string,
      },
    });
  });
}

/** The stored hash of one account, for a compare INSIDE the DO. Never put the return value on the wire. */
export function hashOf(db: SyncSql, userId: string): string | null {
  const r = one(db, `SELECT password_hash FROM _cauth_users WHERE id = ? AND deleted_at IS NULL`, [
    userId,
  ]);
  return r ? (r.password_hash as string) : null;
}

/** Issue a password-reset link for the account with this email. Unknown email -> null (the caller answers identically). */
export function requestReset(
  db: SyncSql,
  a: { email: string; tokenHash: string; rowId: string; expiresAt: number },
  now = Date.now()
): Res<{
  user: Pick<CustomerPublic, 'id' | 'email' | 'firstName' | 'lastName' | 'language'>;
} | null> {
  return db.transactionSync(() => {
    const u = one(
      db,
      `SELECT id, email, first_name, last_name, language FROM _cauth_users WHERE email = ?`,
      [a.email]
    );
    if (!u) return ok(null);
    db.run(
      `INSERT INTO _cauth_tokens (id, token, user_id, type, expires_at, created_at) VALUES (?, ?, ?, 'password_reset', ?, ?)`,
      [a.rowId, a.tokenHash, u.id, a.expiresAt, now]
    );
    db.run(
      `DELETE FROM _cauth_tokens WHERE user_id = ? AND type = 'password_reset' AND id NOT IN
         (SELECT id FROM _cauth_tokens WHERE user_id = ? AND type = 'password_reset' ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      [u.id, u.id, MAX_RESET_LINKS]
    );
    return ok({
      user: {
        id: u.id as string,
        email: u.email as string,
        firstName: u.first_name as string,
        lastName: u.last_name as string,
        language: u.language as string,
      },
    });
  });
}

/** Redeem a reset link: claim it by DELETE (single use), set the password, drop passkeys, revoke everything. One section. */
export function resetPassword(
  db: SyncSql,
  a: { tokenHash: string; newHash: string },
  now = Date.now()
): Res<{
  userId: string;
  email: string;
  firstName: string;
  language: string;
  purgedPasskeys: number;
  tokenVersion: number;
}> {
  return db.transactionSync(() => {
    const t = one(
      db,
      `SELECT id, user_id FROM _cauth_tokens WHERE token = ? AND type = 'password_reset' AND expires_at > ?`,
      [a.tokenHash, now]
    );
    if (!t) return no('TOKEN_INVALID', 400, 'Invalid or expired reset token');
    const claimed = db.run(`DELETE FROM _cauth_tokens WHERE id = ?`, [t.id]);
    if (claimed.changes !== 1) return no('TOKEN_INVALID', 400, 'Invalid or expired reset token');
    const u = one(
      db,
      `SELECT id, email, first_name, language FROM _cauth_users WHERE id = ? AND deleted_at IS NULL`,
      [t.user_id]
    );
    if (!u) return no('TOKEN_INVALID', 400, 'Invalid or expired reset token');
    db.run(`UPDATE _cauth_users SET password_hash = ?, updated_at = ? WHERE id = ?`, [
      a.newHash,
      now,
      u.id,
    ]);
    const purged = db.run(`DELETE FROM _cauth_passkeys WHERE user_id = ?`, [u.id]).changes;
    const tokenVersion = revokeAllIn(db, u.id as string, 'password_reset', now);
    return ok({
      userId: u.id as string,
      email: u.email as string,
      firstName: u.first_name as string,
      language: u.language as string,
      purgedPasskeys: purged,
      tokenVersion,
    });
  });
}

// ---- passkeys -----------------------------------------------------------------------------------------------------------
export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  rpId: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
const toPasskey = (r: Row): PasskeyRow => ({
  id: r.id as string,
  userId: r.user_id as string,
  credentialId: r.credential_id as string,
  publicKey: r.public_key as string,
  counter: Number(r.counter),
  transports: JSON.parse((r.transports as string) || '[]') as string[],
  deviceType: r.device_type as string,
  backedUp: bool(r.backed_up),
  rpId: r.rp_id as string,
  name: r.name as string,
  createdAt: Number(r.created_at),
  lastUsedAt: num(r.last_used_at),
});

export function passkeyList(db: SyncSql, a: { userId: string }): Res<PasskeyRow[]> {
  return ok(
    db
      .all(`SELECT * FROM _cauth_passkeys WHERE user_id = ? ORDER BY created_at ASC, rowid ASC`, [
        a.userId,
      ])
      .map(toPasskey)
  );
}

export function passkeyAdd(
  db: SyncSql,
  a: Omit<PasskeyRow, 'createdAt' | 'lastUsedAt'>,
  now = Date.now()
): Res<PasskeyRow> {
  return db.transactionSync(() => {
    const owner = one(db, `SELECT mfa_enabled, mfa_secret FROM _cauth_users WHERE id = ?`, [
      a.userId,
    ]);
    if (!owner) return no('NOT_FOUND', 404, 'User not found');
    // Ruling NZ-N9-1: TOTP is not ported; an MFA account must not gain a passkey (a second-factor-free way in)
    if (bool(owner.mfa_enabled) && owner.mfa_secret)
      return no('MFA_UNAVAILABLE', 409, 'MFA account');
    if (one(db, `SELECT 1 AS x FROM _cauth_passkeys WHERE credential_id = ?`, [a.credentialId]))
      return no('PASSKEY_EXISTS', 409, 'credential already registered');
    db.run(
      `INSERT INTO _cauth_passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, rp_id, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        a.id,
        a.userId,
        a.credentialId,
        a.publicKey,
        a.counter,
        JSON.stringify(a.transports ?? []),
        a.deviceType,
        a.backedUp ? 1 : 0,
        a.rpId,
        a.name,
        now,
      ]
    );
    return ok(toPasskey(one(db, `SELECT * FROM _cauth_passkeys WHERE id = ?`, [a.id])!));
  });
}

export function passkeyRename(
  db: SyncSql,
  a: { userId: string; id: string; name: string }
): Res<{ updated: number }> {
  return ok({
    updated: db.run(`UPDATE _cauth_passkeys SET name = ? WHERE id = ? AND user_id = ?`, [
      a.name,
      a.id,
      a.userId,
    ]).changes,
  });
}

export function passkeyRemove(
  db: SyncSql,
  a: { userId: string; id: string }
): Res<{ removed: number; name: string | null }> {
  return db.transactionSync(() => {
    const r = one(db, `SELECT name FROM _cauth_passkeys WHERE id = ? AND user_id = ?`, [
      a.id,
      a.userId,
    ]);
    const n = db.run(`DELETE FROM _cauth_passkeys WHERE id = ? AND user_id = ?`, [
      a.id,
      a.userId,
    ]).changes;
    return ok({ removed: n, name: (r?.name as string | undefined) ?? null });
  });
}

/** Credential-less sign-in lookup: the credential id, scoped to THIS store's DO by construction. Includes the account state. */
export function passkeyLookup(
  db: SyncSql,
  a: { credentialId: string }
): Res<{ passkey: PasskeyRow; user: CustomerPublic } | null> {
  const p = one(db, `SELECT * FROM _cauth_passkeys WHERE credential_id = ?`, [a.credentialId]);
  if (!p) return ok(null);
  const u = userById(db, p.user_id as string);
  return ok(u ? { passkey: toPasskey(p), user: toPublic(u) } : null);
}

/** Advance the sign count by compare-and-set: two racing assertions cannot both advance it. */
export function passkeyTouch(
  db: SyncSql,
  a: { id: string; userId: string; counter: number; backedUp: boolean },
  now = Date.now()
): Res<{ touched: boolean }> {
  const n = db.run(
    `UPDATE _cauth_passkeys SET counter = ?, last_used_at = ?, backed_up = ?
       WHERE id = ? AND user_id = ? AND (? = 0 OR counter < ?)`,
    [a.counter, now, a.backedUp ? 1 : 0, a.id, a.userId, a.counter, a.counter]
  ).changes;
  return ok({ touched: n === 1 });
}

// ---- erasure / export / retention -----------------------------------------------------------------------------------------
/** Self-service account deactivation: soft-delete + revoke everything NOW (the version bump kills access tokens at once). */
export function softDelete(
  db: SyncSql,
  a: { userId: string },
  now = Date.now()
): Res<{ tokenVersion: number; phone: string | null }> {
  return db.transactionSync(() => {
    const u = one(db, `SELECT phone FROM _cauth_users WHERE id = ?`, [a.userId]);
    if (!u) return no('NOT_FOUND', 404, 'User not found');
    db.run(
      `UPDATE _cauth_users SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`,
      [now, now, a.userId]
    );
    return ok({
      tokenVersion: revokeAllIn(db, a.userId, 'account_deleted', now),
      phone: (u.phone as string | null) ?? null,
    });
  });
}

/** PDPL erasure of the AUTH side of one customer: anonymise the account row, delete tokens and passkeys. Idempotent. */
export function eraseCustomer(
  db: SyncSql,
  a: { userId: string },
  now = Date.now()
): Res<{ erased: boolean; tokenVersion: number | null }> {
  return db.transactionSync(() => {
    const u = one(db, `SELECT id FROM _cauth_users WHERE id = ?`, [a.userId]);
    if (!u) return ok({ erased: false, tokenVersion: null });
    db.run(
      `UPDATE _cauth_users SET email = ?, password_hash = ?, first_name = 'Deleted', last_name = 'User', phone = NULL, avatar = NULL,
         date_of_birth = NULL, status = 'inactive', email_verified = 0, deleted_at = COALESCE(deleted_at, ?), mfa_enabled = 0,
         mfa_secret = NULL, mfa_backup_codes = '[]', mfa_enrolled_at = NULL, token_version = token_version + 1, updated_at = ?,
         erased_at = ?
       WHERE id = ?`,
      [`erased-${a.userId}@anonymized.local`, '!', now, now, now, a.userId]
    );
    db.run(`DELETE FROM _cauth_refresh WHERE user_id = ?`, [a.userId]);
    db.run(`DELETE FROM _cauth_tokens WHERE user_id = ?`, [a.userId]);
    db.run(`DELETE FROM _cauth_passkeys WHERE user_id = ?`, [a.userId]);
    return ok({
      erased: true,
      tokenVersion: Number(
        one(db, `SELECT token_version FROM _cauth_users WHERE id = ?`, [a.userId])!.token_version
      ),
    });
  });
}

/** The data-portability slice for the auth side: profile + passkey LABELS. Never a hash, a secret or a key. */
export function exportCustomer(
  db: SyncSql,
  a: { userId: string }
): Res<{
  profile: CustomerPublic;
  passkeys: Array<{
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    deviceType: string;
    backedUp: boolean;
  }>;
} | null> {
  const u = userById(db, a.userId);
  if (!u) return ok(null);
  const pk = passkeyList(db, a);
  const passkeys = (pk.ok ? pk.data : []).map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
  }));
  return ok({ profile: toPublic(u), passkeys });
}

/** Daily retention (the DO alarm): expired tokens and old revoked refresh rows. Returns rows deleted. */
export function purgeCustomerAuth(db: SyncSql, now = Date.now()): number {
  return db.transactionSync(() => {
    let n = 0;
    n += db.run(
      `DELETE FROM _cauth_refresh WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      [now, now - REVOKED_RETENTION_MS]
    ).changes;
    n += db.run(`DELETE FROM _cauth_tokens WHERE expires_at < ? OR used_at IS NOT NULL`, [
      now - 24 * 60 * 60 * 1000,
    ]).changes;
    return n;
  });
}

// ---- cutover import / verify ---------------------------------------------------------------------------------------------
/** Column order of each table as the cutover script sends and digests it. The primary key is the first column. */
export const IMPORT_COLUMNS: Record<(typeof CAUTH_TABLES)[number], readonly string[]> = {
  _cauth_users: [
    'id',
    'email',
    'password_hash',
    'first_name',
    'last_name',
    'phone',
    'status',
    'email_verified',
    'avatar',
    'date_of_birth',
    'language',
    'last_login_at',
    'created_at',
    'updated_at',
    'deleted_at',
    'mfa_enabled',
    'mfa_secret',
    'mfa_backup_codes',
    'mfa_enrolled_at',
    'token_version',
  ],
  _cauth_refresh: [
    'id',
    'token',
    'user_id',
    'expires_at',
    'created_at',
    'replaced_by_id',
    'revoked_at',
    'revoked_reason',
  ],
  _cauth_tokens: ['id', 'token', 'user_id', 'type', 'expires_at', 'used_at', 'created_at'],
  _cauth_passkeys: [
    'id',
    'user_id',
    'credential_id',
    'public_key',
    'counter',
    'transports',
    'device_type',
    'backed_up',
    'rp_id',
    'name',
    'created_at',
    'last_used_at',
  ],
};

export const isLive = (db: SyncSql): boolean =>
  !!one(db, `SELECT 1 AS x FROM _cauth_state WHERE k = 'live'`);

/** Mark the import closed. After this `importRows` is refused (423): a re-run can never overwrite what the DO accepted since. */
export function markLive(db: SyncSql, now = Date.now()): void {
  db.run(`INSERT INTO _cauth_state (k, v) VALUES ('live', ?) ON CONFLICT (k) DO NOTHING`, [
    String(now),
  ]);
}

/** Idempotent upsert of one page, one section. Refused once live. */
export function importRows(
  db: SyncSql,
  a: { table: string; rows: unknown[][] }
): Res<{ imported: number }> {
  const table = a.table as (typeof CAUTH_TABLES)[number];
  const cols = IMPORT_COLUMNS[table];
  if (!cols) return no('IMPORT_TABLE_UNKNOWN', 400, 'unknown table');
  if (!Array.isArray(a.rows) || a.rows.length > 1000)
    return no('IMPORT_PAGE_INVALID', 400, 'page too large');
  return db.transactionSync(() => {
    if (isLive(db))
      return no(
        'CUSTOMER_AUTH_LIVE',
        423,
        'customer auth is live on this store: imports are closed'
      );
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT (${cols[0]}) DO UPDATE SET ${cols
        .slice(1)
        .map(c => `${c} = excluded.${c}`)
        .join(', ')}`;
    for (const r of a.rows) {
      if (!Array.isArray(r) || r.length !== cols.length)
        throw new Error(`row shape mismatch for ${table}`);
      db.run(sql, r);
    }
    return ok({ imported: a.rows.length });
  });
}

/** Row count + the rows in primary-key order, for the script's digest (it hashes them with the same canon as the cutover). */
export function exportRowsPage(
  db: SyncSql,
  a: { table: string; after: string | null; limit: number }
): Res<{ rows: unknown[][]; next: string | null }> {
  const table = a.table as (typeof CAUTH_TABLES)[number];
  const cols = IMPORT_COLUMNS[table];
  if (!cols) return no('IMPORT_TABLE_UNKNOWN', 400, 'unknown table');
  const limit = Math.min(Math.max(1, a.limit | 0), 1000);
  const rows = db.all(
    `SELECT ${cols.join(', ')} FROM ${table} WHERE (? IS NULL OR ${cols[0]} > ?) ORDER BY ${cols[0]} ASC LIMIT ?`,
    [a.after, a.after, limit]
  );
  const out = rows.map(r => cols.map(c => (r[c] === undefined ? null : r[c])) as unknown[]);
  return ok({
    rows: out,
    next: rows.length === limit ? (rows[rows.length - 1][cols[0]] as string) : null,
  });
}

export function counts(db: SyncSql): Record<string, number> {
  const o: Record<string, number> = {};
  for (const t of CAUTH_TABLES) o[t] = Number(one(db, `SELECT count(*) AS n FROM ${t}`)!.n);
  return o;
}
