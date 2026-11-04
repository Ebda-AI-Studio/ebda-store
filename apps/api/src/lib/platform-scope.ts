/**
 * NEON-ZERO (Ruling NZ-C-5): the super-admin "act as operator / act as user" scopes, without Postgres.
 *
 * `asPlatformOperator` and `withUser` each open a Postgres transaction (`BEGIN` + `set_config`, and for the operator a
 * `ebda_is_super_admin()` check), so every platform-hub handler that used them was a 500 with Postgres dead. Once the
 * `billing`, `access` and `platform` families are on D1 the data those handlers touch is D1 (routed models) plus the identity service, so:
 *   - `asOperator` checks that the acting account is an ACTIVE super_admin with the identity service (the account of record),
 *     then runs `fn` in the lazy per-query user scope (`runInUserScope`): a call that still reaches Postgres runs in its own short
 *     transaction carrying `app.current_user_id`; nothing leases a connection otherwise;
 *   - `withPlatformUser` is the same scope without the role check (the route's `authorize` is the gate).
 * Before the markers exist (and in Node / unit tests, where there is no D1 binding) both are exactly the Postgres helpers they
 * replace. An unreadable marker or identity service is a 503 (fail closed), never a Postgres fallback.
 * Cost if wrong: a demoted super_admin whose identity record is stale could run a job step until the next identity read.
 */
import { asPlatformOperator, runInUserScope, withUser } from '@ebda/database';
import { getAccountState } from './identity-client';
import { hubOnD1 } from './platform-hub';

/** True when the platform hub is served by D1 + the identity service (billing, access and platform all moved). */
export const platformHubOnD1 = hubOnD1;

/** `asPlatformOperator` that works with Postgres dead (see the header). */
export async function asOperator<T>(operatorId: string, fn: () => Promise<T>): Promise<T> {
  if (!(await platformHubOnD1())) return asPlatformOperator(operatorId, fn);
  const account = await getAccountState(operatorId);
  if (account?.role !== 'super_admin' || account.status !== 'active') {
    throw new Error('asOperator: the acting user is not an active super_admin');
  }
  return runInUserScope(operatorId, fn);
}

/** `withUser(userId, fn)` for platform-hub handlers whose data is D1 (the route's `authorize` is the gate). */
export async function withPlatformUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (!(await platformHubOnD1())) return withUser(userId, fn);
  return runInUserScope(userId, fn);
}
