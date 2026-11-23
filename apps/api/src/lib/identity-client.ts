/**
 * The Store's client for the shared identity service (Service Binding `ACCOUNTS`, Rulings ID-1/ID-2).
 * Every call fails CLOSED: a missing binding or a failed call is an AppError 503, never a silent "allowed".
 */
import { cfBindings, type AccountBrief, type AccountsRpc, type AccountState } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { getUserState } from './definer';
import { invalidateAccountState, resetLiveIdentityCache } from './identity-live-cache';

let override: AccountsRpc | undefined;
/** Test seam. */
export function configureIdentityClient(fake?: AccountsRpc): void {
  override = fake;
  resetLiveIdentityCache();
}

function rpc(): AccountsRpc {
  const b = override ?? cfBindings()?.ACCOUNTS;
  if (!b) throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in service is not configured');
  return b;
}

async function call<T>(
  name: keyof AccountsRpc,
  fn: (r: AccountsRpc) => Promise<T> | undefined
): Promise<T> {
  try {
    const p = fn(rpc());
    if (!p) throw new Error(`ACCOUNTS.${String(name)} is not available`);
    return await p;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in service unavailable, try again');
  }
}

/** Display facts for many accounts in ONE identity call (chunks of 100). Unknown / erased ids are absent from the result. */
export async function getAccountsBrief(userIds: string[]): Promise<AccountBrief[]> {
  const unique = [...new Set(userIds)];
  const out: AccountBrief[] = [];
  for (let i = 0; i < unique.length; i += 100)
    out.push(
      ...(await call('getAccountsBrief', r => r.getAccountsBrief?.(unique.slice(i, i + 100))))
    );
  return out;
}

export const getAccountState = (userId: string): Promise<AccountState | null> =>
  call('getAccountState', r => r.getAccountState?.(userId));
// The state changers below drop the cached account state (lib/identity-live-cache.ts, NEVER-stale class) in `finally`:
// even a call that threw may have landed upstream, and a stale "active" must not outlive it.
async function thenInvalidate<T>(match: { userId: string }, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    invalidateAccountState(match.userId);
  }
}
export const setAccountStatus = (
  userId: string,
  status: 'active' | 'inactive' | 'suspended',
  reason: string
) =>
  thenInvalidate({ userId }, () => call('setStatus', r => r.setStatus?.(userId, status, reason)));
export const updateIdentityProfile = (
  userId: string,
  input: { firstName?: string; lastName?: string; phone?: string | null },
  reason = 'admin-update',
  actorId?: string
) =>
  thenInvalidate({ userId }, () =>
    call('updateProfile', r => r.updateProfile?.(userId, input, reason, actorId))
  );
export const revokeIdentitySession = (sid: string, reason: string) =>
  call('revokeSession', r => r.revokeSession?.(sid, reason));
export const revokeIdentityUser = (userId: string, reason: string) =>
  thenInvalidate({ userId }, () => call('revokeUser', r => r.revokeUser?.(userId, reason)));
export const createIdentity = (input: Parameters<NonNullable<AccountsRpc['createUser']>>[0]) =>
  call('createUser', r => r.createUser?.(input));
export const identityAccountIdByEmail = (email: string) =>
  call('accountIdByEmail', r => r.accountIdByEmail?.(email));
export const resendIdentityVerification = (email: string) =>
  call('resendVerification', r => r.resendVerification?.(email));
export const inviteIdentity = (input: Parameters<NonNullable<AccountsRpc['inviteUser']>>[0]) =>
  call('inviteUser', r => r.inviteUser?.(input));
export const forgotIdentityPassword = (email: string) =>
  call('forgotPassword', r => r.forgotPassword?.(email));
export const setAccountRole = (
  userId: string,
  role: 'store_admin' | 'staff',
  reason: string,
  ifCurrentRole?: 'store_admin' | 'staff'
) =>
  thenInvalidate({ userId }, () =>
    call('setRole', r => r.setRole?.(userId, role, reason, ifCurrentRole))
  );
export const eraseIdentityUser = (userId: string) => call('eraseUser', r => r.eraseUser?.(userId));
/** PDPL export of the identity service's own rows for the user (profile, sessions, passkey labels; never a hash or key). */
export const exportIdentityUser = (userId: string) =>
  call('exportUser', r => r.exportUser?.(userId));
/** Integrator clients (identity v1.3) die with their store. Idempotent, so a retry is safe. */
export const deleteStoreClients = (storeId: string) =>
  call('deleteStoreClients', r => r.deleteStoreClients?.(storeId));

/**
 * Merchant, staff and super-admin accounts (users.store_id NULL, role not customer) have their credentials and sessions in the
 * identity service; customers do not. Reads the user's state through the definer, so it works under any tenant scope.
 */
export async function isIdentityManagedUser(userId: string): Promise<boolean> {
  const st = await getUserState(userId);
  return !!st && st.storeId === null && st.role !== 'customer';
}

/** Every Store path that ends a user's sessions must end them at the identity service too, or refresh keeps working. */
export async function revokeIdentityIfManaged(userId: string, reason: string): Promise<void> {
  if (await isIdentityManagedUser(userId)) await revokeIdentityUser(userId, reason);
}
