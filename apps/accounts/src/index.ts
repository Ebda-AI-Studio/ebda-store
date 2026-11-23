import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createApp,
  forgotPasswordFor,
  inviteFor,
  registerPending,
  resendVerificationFor,
  type InviteResult,
} from './app';
import {
  eraseIdentity,
  exportIdentity,
  findUserByEmail,
  isSessionRevoked,
  revokeAllForUser,
  revokeSession,
  superAdminSummary,
  type UserRow,
} from './data';
import { z } from 'zod/v3';
import { reencryptMfaSecrets } from './mfa-keys';
import {
  deleteStoreClients,
  isClientRevoked,
  pruneClientAudit,
  sweepDeletedStoreClients,
} from './clients';
import { hashPassword, passwordPolicy } from './password';

const app = createApp();

export default {
  fetch: (req: Request, env: Cloudflare.Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Hourly: re-seal TOTP secrets that are not on the current MFA key (a no-op once none are left).
  scheduled: (_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) => {
    ctx.waitUntil(reencryptMfaSecrets(env));
    // integrator client trail: `issued` rows older than 90 days go
    ctx.waitUntil(pruneClientAudit(env.DB));
    // clients of deleted stores: retried every hour until the directory confirms they are gone
    const dir = env.STORE_DIRECTORY;
    if (dir) ctx.waitUntil(sweepDeletedStoreClients(env.DB, id => dir.storeExists(id)));
  },
} satisfies ExportedHandler<Cloudflare.Env>;

/**
 * Service Binding RPC for the products (token contract: `Accounts.isRevoked(sid)`, `Accounts.issue(sid, aud)`).
 * A Service Binding is wired in wrangler config of the CALLING Worker, so only Workers we deploy can reach this.
 */
export class Accounts extends WorkerEntrypoint<Cloudflare.Env> {
  /** The same HTTP app, so a Service Binding to this entrypoint can fetch the public JWKS and RPC in one binding. */
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx as unknown as ExecutionContext);
  }

  async isRevoked(sid: string): Promise<boolean> {
    // An integrator client token (v1.3) has sid = the client id: it is revoked when the client is revoked, the store was
    // deleted, or the id is unknown. Rotating a secret does not revoke tokens already issued.
    if (sid.startsWith('cli_')) {
      if (await isClientRevoked(this.env.DB, sid)) return true;
      // A deleted store ends its clients at once. A directory error THROWS (the product fails closed), it is never "not revoked".
      const row = await this.env.DB.prepare(`SELECT store_id FROM clients WHERE id = ?1`)
        .bind(sid)
        .first<{ store_id: string }>();
      if (!row || !this.env.STORE_DIRECTORY) return true;
      return !(await this.env.STORE_DIRECTORY.storeActive(row.store_id));
    }
    return isSessionRevoked(this.env.DB, sid);
  }

  /**
   * Store deletion (called from the Store's delete-store flow, inside its compensating-rollback context): removes the store's
   * integrator clients, their secrets and their whole trail. Idempotent. NOTE: no RPC here mints or lists a client token.
   */
  async deleteStoreClients(storeId: string): Promise<{ clients: number }> {
    if (typeof storeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(storeId))
      throw new Error('invalid storeId');
    return deleteStoreClients(this.env.DB, storeId);
  }

  // NOTE: no `issue(sid, aud)`. A Service Binding does not authenticate the caller, so any Worker in the account holding
  // the binding could mint a token for ANY product audience from a sid. Products get tokens over HTTP (`GET /token`, cookie
  // + allow-listed origin). Bring `issue` back only with a proof of possession (a token for the same sid) and a review.

  /**
   * Platform-admin invariant (Ruling ID-20): how many super_admins are active, and how many of those can actually act (address
   * verified = password set through the mailed code, and a second factor enrolled, which is what mints `pa`). Counts only.
   */
  async superAdminSummary(): Promise<{ active: number; ready: number }> {
    return superAdminSummary(this.env.DB);
  }

  /** Revoke every session of a user (suspension, password change by an admin, erasure). */
  async revokeUser(userId: string, reason: string): Promise<void> {
    await revokeAllForUser(this.env.DB, userId, reason.slice(0, 80));
  }

  /** Identity facts the Store mirrors into its profile row at every sign-in (credentials never leave this service). */
  async getAccountState(userId: string): Promise<{
    id: string;
    email: string;
    emailVerified: boolean;
    mfaEnabled: boolean;
    mfaEnrolledAt: string | null;
    status: 'active' | 'inactive' | 'suspended';
    role: 'customer' | 'store_admin' | 'super_admin' | 'staff';
    firstName: string;
    lastName: string;
    phone: string | null;
    language: string;
  } | null> {
    const u = await this.env.DB.prepare(`SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL`)
      .bind(userId)
      .first<UserRow & { mfa_enrolled_at: string | null }>();
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      emailVerified: !!u.email_verified,
      mfaEnabled: !!u.mfa_enabled,
      mfaEnrolledAt: u.mfa_enrolled_at,
      status: u.status,
      role: u.role,
      firstName: u.first_name,
      lastName: u.last_name,
      phone: u.phone,
      language: u.language,
    };
  }

  /**
   * Display facts for MANY accounts in one call (staff lists, member pickers): ONE D1 statement, at most 100 ids, no credential,
   * no phone. Unknown or erased ids are simply absent. The Store calls it so a list of N members costs one identity read, not N.
   */
  async getAccountsBrief(userIds: string[]): Promise<
    Array<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      status: 'active' | 'inactive' | 'suspended';
      role: 'customer' | 'store_admin' | 'super_admin' | 'staff';
      lastLoginAt: string | null;
      createdAt: string;
    }>
  > {
    const ids = z.array(z.string().uuid()).max(100).parse(userIds);
    if (ids.length === 0) return [];
    const marks = ids.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await this.env.DB.prepare(
      `SELECT id, email, first_name, last_name, status, role, last_login_at, created_at FROM users WHERE id IN (${marks}) AND deleted_at IS NULL`
    )
      .bind(...ids)
      .all<{
        id: string;
        email: string;
        first_name: string;
        last_name: string;
        status: 'active' | 'inactive' | 'suspended';
        role: 'customer' | 'store_admin' | 'super_admin' | 'staff';
        last_login_at: string | null;
        created_at: string;
      }>();
    return (results ?? []).map(u => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      status: u.status,
      role: u.role,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
    }));
  }

  /** Suspend / reactivate an account (a Store super-admin action). Leaving 'active' ends every session. */
  async setStatus(
    userId: string,
    status: 'active' | 'inactive' | 'suspended',
    reason: string
  ): Promise<void> {
    z.string().uuid().parse(userId);
    z.enum(['active', 'inactive', 'suspended']).parse(status);
    await this.env.DB.prepare(`UPDATE users SET status = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(userId, status, new Date().toISOString())
      .run();
    if (status !== 'active') await revokeAllForUser(this.env.DB, userId, reason.slice(0, 80));
  }

  /**
   * Edit the NAME and PHONE of a merchant / staff / super-admin account (a Store super-admin action). Only the fields passed
   * change; `phone: null` clears it. The e-mail is NOT editable here and `.strict()` rejects it: an e-mail is the recovery
   * channel, so only the verified self-service flow (new address confirmed, old one notified) may change it; an admin edit
   * would be an account-takeover path (security review). A `super_admin` target may be edited only by that same user
   * (`actorId`); anyone else gets `{ ok:false, code:'FORBIDDEN_TARGET' }` and nothing changes. Customers are not reachable
   * here (they live in their store). Credentials are never touched.
   */
  async updateProfile(
    userId: string,
    input: { firstName?: string; lastName?: string; phone?: string | null },
    reason = 'profile-update',
    actorId?: string
  ): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN_TARGET' }> {
    z.string().uuid().parse(userId);
    const v = z
      .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        phone: z.string().trim().max(40).nullable().optional(),
      })
      .strict()
      .parse(input);
    const cur = await this.env.DB.prepare(
      `SELECT role FROM users WHERE id = ?1 AND role != 'customer' AND deleted_at IS NULL`
    )
      .bind(userId)
      .first<{ role: string }>();
    if (!cur) return { ok: false, code: 'NOT_FOUND' };
    if (cur.role === 'super_admin' && actorId !== userId)
      return { ok: false, code: 'FORBIDDEN_TARGET' };
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = ?${args.length + 1}`);
    };
    if (v.firstName !== undefined) add('first_name', v.firstName);
    if (v.lastName !== undefined) add('last_name', v.lastName);
    if (v.phone !== undefined) add('phone', v.phone === null || v.phone === '' ? null : v.phone);
    if (sets.length === 0) return { ok: true };
    add('updated_at', new Date().toISOString());
    await this.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`)
      .bind(userId, ...args)
      .run();
    void reason;
    return { ok: true };
  }

  /**
   * Delete an identity (erasure, hard delete). Idempotent. Sessions, refresh tokens, codes and passkeys go with it (foreign
   * keys), so no token or refresh cookie of this user can ever be honoured again, and the Store cannot re-create its profile
   * row from a deleted identity (it reconciles only from an identity that still exists).
   */
  async eraseUser(
    userId: string,
    requestId?: string
  ): Promise<{ erased: boolean; remaining: number }> {
    z.string().uuid().parse(userId);
    if (requestId !== undefined) z.string().min(1).max(100).parse(requestId);
    return eraseIdentity(this.env.DB, userId, requestId);
  }

  /**
   * PDPL data export (G10): the user's identity data as JSON, one array per table. Credentials and secrets (password hash,
   * MFA secret and backup codes, token hashes, passkey public keys, pending signup data) are never exported: they are not
   * the person's data to take and exporting them would be a risk. Unknown user = every array empty.
   */
  async exportUser(userId: string): Promise<Record<string, unknown[]>> {
    z.string().uuid().parse(userId);
    return exportIdentity(this.env.DB, userId);
  }

  /** Change an admin-namespace role (promote/demote). Ends every session so tokens are re-issued with the new grant. */
  async setRole(
    userId: string,
    role: 'store_admin' | 'staff',
    reason: string,
    /** Compare-and-set: change the role only if it currently equals this (used by rollbacks). */
    ifCurrentRole?: 'store_admin' | 'staff'
  ): Promise<boolean> {
    z.string().uuid().parse(userId);
    // super_admin is deliberately NOT grantable over RPC: any Worker in the account can call this binding, so platform
    // operators are created only by an operator-run D1 statement (Ruling ID-12).
    z.enum(['store_admin', 'staff']).parse(role);
    if (ifCurrentRole !== undefined) z.enum(['store_admin', 'staff']).parse(ifCurrentRole);
    const r = await this.env.DB.prepare(
      `UPDATE users SET role = ?2, updated_at = ?3 WHERE id = ?1 AND (?4 IS NULL OR role = ?4)`
    )
      .bind(userId, role, new Date().toISOString(), ifCurrentRole ?? null)
      .run();
    // A compare-and-set that matched nothing changed nothing, so it must not end anyone's sessions either.
    if ((r.meta?.changes ?? 0) === 0) return false;
    await revokeAllForUser(this.env.DB, userId, reason.slice(0, 80));
    return true;
  }

  /** Invite a merchant or staff member: an unverified identity plus a one-time code to set their own password. */
  async inviteUser(input: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'store_admin' | 'staff';
    language?: 'en' | 'ar';
    storeName?: string;
  }): Promise<InviteResult> {
    const v = z
      .object({
        id: z.string().uuid(),
        email: z.string().trim().toLowerCase().email().max(254),
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().max(100),
        role: z.enum(['store_admin', 'staff']),
        language: z.enum(['en', 'ar']).default('ar'),
        storeName: z.string().trim().max(200).optional(),
      })
      .parse(input);
    return inviteFor(this.env, v);
  }

  /**
   * The id of the live admin-namespace account for an address, or null. Store-internal (Service Binding only): the Store uses
   * it to ask "does this address belong to the demo showroom's owner?" before it hands a mail job to this service (Ruling B1-13).
   */
  async accountIdByEmail(email: string): Promise<string | null> {
    const row = await findUserByEmail(
      this.env.DB,
      z.string().trim().toLowerCase().email().max(254).parse(email)
    );
    return row?.id ?? null;
  }

  /** Mail a password-reset code (generic: silent for an unknown or inactive address). */
  async forgotPassword(email: string): Promise<void> {
    await forgotPasswordFor(
      this.env,
      z.string().trim().toLowerCase().email().max(254).parse(email)
    );
  }

  /** Re-seal TOTP secrets onto the current MFA key (rotation). Same job as the hourly cron; returns what it did. */
  async reencryptMfa(limit?: number) {
    return reencryptMfaSecrets(
      this.env,
      z.number().int().min(1).max(1000).default(200).parse(limit)
    );
  }

  /** Re-send the verification code (generic: does nothing for an unknown or already verified address). */
  async resendVerification(email: string): Promise<void> {
    await resendVerificationFor(
      this.env,
      z.string().trim().toLowerCase().email().max(254).parse(email)
    );
  }

  async revokeSession(sid: string, reason: string): Promise<void> {
    await revokeSession(this.env.DB, sid, reason.slice(0, 80));
  }

  /**
   * Create (or re-register) an UNVERIFIED merchant identity for the Store's provisioning flow and mail the verification code.
   * The credential is bound to that code (see registerPending), never written to an existing row. Returns null when the
   * address already belongs to a VERIFIED account.
   */
  async createUser(input: {
    id?: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    language?: 'en' | 'ar';
  }): Promise<{ id: string } | null> {
    passwordPolicy.parse(input.password);
    const email = z.string().trim().toLowerCase().email().max(254).parse(input.email);
    if (input.id !== undefined) z.string().uuid().parse(input.id);
    const r = await registerPending(this.env, {
      id: input.id,
      email,
      passwordHash: await hashPassword(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      language: input.language ?? 'en',
    });
    return r ? { id: r.id } : null;
  }
}
