import * as A from '../do/customer-auth';
import type { SyncSql } from '../do/sync-sql';
import { decodeRpc, encodeRpc } from './codec';

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
  credential: A.credential,
  credentialById: A.credentialById,
  loginSucceeded: A.loginSucceeded,
  setStatus: A.setStatus,
  profiles: A.profiles,
  newest: A.newest,
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
  'changePassword',
  'counts',
  'markLive',
  'isLive',
];

type R = A.Res<unknown>;

async function run(db: SyncSql, op: string, a: Record<string, any>): Promise<R> {
  switch (op) {
    case 'changePassword':
      // the Worker verified the current password against the hash it was handed; the DO re-checks that hash is still current
      return A.setPasswordRevokingAll(db, {
        userId: String(a.userId),
        expectedHash: String(a.expectedHash),
        newHash: String(a.newHash),
        reason: 'password_changed',
      });
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
export async function answerAuthOp(db: SyncSql, op: string, argsJson: string): Promise<AuthAnswer> {
  try {
    const args = decodeRpc<Record<string, unknown>>(argsJson) ?? {};
    const r = await run(db, op, args);
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
