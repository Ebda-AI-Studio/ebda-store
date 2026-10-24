/**
 * The Store's client for the shared identity service (Service Binding `ACCOUNTS`, Rulings ID-1/ID-2).
 * Every call fails CLOSED: a missing binding or a failed call is an AppError 503, never a silent "allowed".
 */
import { cfBindings, type AccountsRpc, type AccountState } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';

let override: AccountsRpc | undefined;
/** Test seam. */
export function configureIdentityClient(fake?: AccountsRpc): void {
  override = fake;
}

function rpc(): AccountsRpc {
  const b = override ?? cfBindings()?.ACCOUNTS;
  if (!b) throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in service is not configured');
  return b;
}

async function call<T>(name: keyof AccountsRpc, fn: (r: AccountsRpc) => Promise<T> | undefined): Promise<T> {
  try {
    const p = fn(rpc());
    if (!p) throw new Error(`ACCOUNTS.${String(name)} is not available`);
    return await p;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'IDENTITY_UNAVAILABLE', 'Sign-in service unavailable, try again');
  }
}

export const getAccountState = (userId: string): Promise<AccountState | null> =>
  call('getAccountState', r => r.getAccountState?.(userId));
export const setAccountStatus = (userId: string, status: 'active' | 'inactive' | 'suspended', reason: string) =>
  call('setStatus', r => r.setStatus?.(userId, status, reason));
export const revokeIdentitySession = (sid: string, reason: string) =>
  call('revokeSession', r => r.revokeSession?.(sid, reason));
export const revokeIdentityUser = (userId: string, reason: string) =>
  call('revokeUser', r => r.revokeUser?.(userId, reason));
export const createIdentity = (input: Parameters<NonNullable<AccountsRpc['createUser']>>[0]) =>
  call('createUser', r => r.createUser?.(input));
export const resendIdentityVerification = (email: string) =>
  call('resendVerification', r => r.resendVerification?.(email));
export const setAccountRole = (userId: string, role: 'store_admin' | 'staff' | 'super_admin', reason: string) =>
  call('setRole', r => r.setRole?.(userId, role, reason));
