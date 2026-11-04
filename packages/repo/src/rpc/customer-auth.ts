import * as A from '../do/customer-auth';
import type { SyncSql } from '../do/sync-sql';
import { decodeRpc, encodeRpc } from './codec';

/** Password verification supplied by the host (bcryptjs in the API bundle); it runs INSIDE the DO so a hash never leaves it. */
export interface PasswordVerifier {
  compare(plain: string, hash: string): Promise<boolean>;
  /** A hash of a value no caller can provide: compared when the account is unknown so timing does not reveal existence. */
  dummyHash: string;
}

export type AuthAnswer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message: string };

const SYNC_OPS = {
  register: A.register,
  verifyEmail: A.verifyEmail,
  resendVerification: A.resendVerification,
  issueSession: A.issueSession,
  rotateRefresh: A.rotateRefresh,
  logout: A.logout,
  userState: A.userState,
  getProfile: A.getProfile,
  updateProfile: A.updateProfile,
  revokeAll: A.revokeAll,
  requestReset: A.requestReset,
  resetPassword: A.resetPassword,
  passkeyList: A.passkeyList,
  passkeyAdd: A.passkeyAdd,
  passkeyRename: A.passkeyRename,
  passkeyRemove: A.passkeyRemove,
  passkeyLookup: A.passkeyLookup,
  passkeyTouch: A.passkeyTouch,
  eraseCustomer: A.eraseCustomer,
  softDelete: A.softDelete,
  setStatus: A.setStatus,
  profiles: A.profiles,
  newest: A.newest,
  search: A.search,
  expiredDeleted: A.expiredDeleted,
  exportCustomer: A.exportCustomer,
  importRows: A.importRows,
  exportRowsPage: A.exportRowsPage,
} as const;
export type AuthOpName =
  | keyof typeof SYNC_OPS
  | 'login'
  | 'changePassword'
  | 'verifyPassword'
  | 'counts'
  | 'markLive'
  | 'isLive';
export const AUTH_OP_NAMES: readonly string[] = [
  ...Object.keys(SYNC_OPS),
  'login',
  'changePassword',
  'verifyPassword',
  'counts',
  'markLive',
  'isLive',
];

type R = A.Res<unknown>;

async function run(
  db: SyncSql,
  v: PasswordVerifier,
  op: string,
  a: Record<string, any>
): Promise<R> {
  switch (op) {
    case 'login': {
      // lookup (sync) -> compare (async, the only await) -> re-validate + stamp (sync). Between the two syncs a reset or
      // revoke may land; loginSucceeded then voids the success.
      const row = A.loginRow(db, String(a.email));
      const good = await v.compare(String(a.password), row ? row.hash : v.dummyHash);
      if (!row || !good) return { ok: true, data: { valid: false } };
      const r = A.loginSucceeded(db, row);
      return r.ok
        ? { ok: true, data: { valid: true, ...r.data } }
        : { ok: true, data: { valid: false } };
    }
    case 'verifyPassword': {
      const h = A.hashOf(db, String(a.userId));
      const good = await v.compare(String(a.password), h ?? v.dummyHash);
      return { ok: true, data: { valid: !!h && good } };
    }
    case 'changePassword': {
      const h = A.hashOf(db, String(a.userId));
      if (!h) return { ok: false, code: 'NOT_FOUND', status: 404, message: 'User not found' };
      if (!(await v.compare(String(a.currentPassword), h)))
        return {
          ok: false,
          code: 'INVALID_PASSWORD',
          status: 400,
          message: 'Current password is incorrect',
        };
      return A.setPasswordRevokingAll(db, {
        userId: String(a.userId),
        expectedHash: h,
        newHash: String(a.newHash),
        reason: 'password_changed',
      });
    }
    case 'counts':
      return { ok: true, data: A.counts(db) };
    case 'markLive':
      A.markLive(db);
      return { ok: true, data: { live: true } };
    case 'isLive':
      return { ok: true, data: { live: A.isLive(db) } };
    default: {
      const fn = (SYNC_OPS as Record<string, (db: SyncSql, a: never) => R>)[op];
      if (!Object.hasOwn(SYNC_OPS, op) || !fn)
        return { ok: false, code: 'AUTH_OP_UNKNOWN', status: 400, message: 'unknown operation' };
      return fn(db, a as never);
    }
  }
}

/** One customer-auth operation as an ANSWER (a refusal is a value, never a throw across the RPC boundary). */
export async function answerAuthOp(
  db: SyncSql,
  v: PasswordVerifier,
  op: string,
  argsJson: string
): Promise<AuthAnswer> {
  try {
    const args = decodeRpc<Record<string, unknown>>(argsJson) ?? {};
    const r = await run(db, v, op, args);
    return r.ok ? { ok: true, json: encodeRpc(r.data) } : r;
  } catch (e) {
    const err = e as { message?: unknown };
    return {
      ok: false,
      code: 'AUTH_OP_FAILED',
      status: 500,
      message: typeof err.message === 'string' ? err.message : 'customer auth operation failed',
    };
  }
}
