// Shared by scripts/cf/cutover-customer-auth.mjs and its test: the Postgres -> StoreDO row transforms of the customer-auth
// family (NEON-ZERO-1 N-9). Column order MUST equal IMPORT_COLUMNS in packages/repo/src/do/customer-auth.ts.
import { TableDigest } from '../../../packages/cf-migrate/src/canon.mjs';

export const REFRESH_REVOKED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const ms = d => (d === null || d === undefined ? null : new Date(d).getTime());
const b = v => (v ? 1 : 0);

/** table -> { sql(store), cols, pk, map(row) }. Customers only (`role = 'customer'`, `store_id` = the store). */
export const TABLES = {
  _cauth_users: {
    cols: [
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
    sql: `SELECT id, email, password_hash, first_name, last_name, phone, status::text AS status, email_verified, avatar, date_of_birth, language, last_login_at, created_at, updated_at, deleted_at, mfa_enabled, mfa_secret, mfa_backup_codes, mfa_enrolled_at, token_version
            FROM users WHERE store_id = $1 AND role = 'customer' ORDER BY id`,
    map: r => [
      r.id,
      r.email,
      r.password_hash,
      r.first_name,
      r.last_name,
      r.phone,
      r.status,
      b(r.email_verified),
      r.avatar,
      ms(r.date_of_birth),
      r.language,
      ms(r.last_login_at),
      ms(r.created_at),
      ms(r.updated_at),
      ms(r.deleted_at),
      b(r.mfa_enabled),
      r.mfa_secret,
      JSON.stringify(r.mfa_backup_codes ?? []),
      ms(r.mfa_enrolled_at),
      r.token_version,
    ],
  },
  // live rows + rows revoked in the last 30 days (reuse detection needs them); `reset:` rows are password-reset links, not sessions
  _cauth_refresh: {
    cols: [
      'id',
      'token',
      'user_id',
      'expires_at',
      'created_at',
      'replaced_by_id',
      'revoked_at',
      'revoked_reason',
    ],
    sql: `SELECT t.id, t.token, t.user_id, t.expires_at, t.created_at, t.replaced_by_id, t.revoked_at, t.revoked_reason
            FROM refresh_tokens t JOIN users u ON u.id = t.user_id
           WHERE u.store_id = $1 AND u.role = 'customer' AND t.token NOT LIKE 'reset:%'
             AND NOT (u.mfa_enabled AND u.mfa_secret IS NOT NULL)
             AND ((t.revoked_at IS NULL AND t.expires_at > now()) OR t.revoked_at > now() - interval '30 days')
           ORDER BY t.id`,
    map: r => [
      r.id,
      r.token,
      r.user_id,
      ms(r.expires_at),
      ms(r.created_at),
      r.replaced_by_id,
      ms(r.revoked_at),
      r.revoked_reason,
    ],
  },
  _cauth_passkeys: {
    cols: [
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
    sql: `SELECT p.id, p.user_id, p.credential_id, p.public_key, p.counter, p.transports, p.device_type, p.backed_up, p.rp_id, p.name, p.created_at, p.last_used_at
            FROM passkey_credentials p JOIN users u ON u.id = p.user_id
           WHERE u.store_id = $1 AND u.role = 'customer' ORDER BY p.id`,
    map: r => [
      r.id,
      r.user_id,
      r.credential_id,
      r.public_key,
      Number(r.counter),
      JSON.stringify(r.transports ?? []),
      r.device_type,
      b(r.backed_up),
      r.rp_id,
      r.name,
      ms(r.created_at),
      ms(r.last_used_at),
    ],
  },
};
// Email-verification and password-reset links are NOT copied: they were mailed without a store id and cannot be redeemed
// against a StoreDO. A link mailed before the flip stops working; the customer requests a new one (24 h / 1 h links).

/**
 * The part of a table's rows that cannot change merely because the clock moved. The refresh query selects "live now, or revoked
 * within 30 days": a token that expires, or a revocation that ages out, DURING the run would otherwise read as drift on the
 * re-check. Both the before-rows and the after-rows are reduced to what is still inside the window at `cutoff` (epoch ms).
 */
export function stableRows(table, rows, cutoff) {
  if (table !== '_cauth_refresh') return rows;
  const EXPIRES = 3;
  const REVOKED = 6;
  return rows.filter(r => {
    const live = r[REVOKED] === null && r[EXPIRES] > cutoff;
    const recentlyRevoked = r[REVOKED] !== null && r[REVOKED] > cutoff - REFRESH_REVOKED_KEEP_MS;
    return live || recentlyRevoked;
  });
}

export async function digestRows(cols, rows) {
  const d = new TableDigest();
  for (const r of rows) await d.add(cols, r, ['id']);
  return d.finish();
}
