import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createApp,
  forgotPasswordFor,
  inviteFor,
  registerPending,
  resendVerificationFor,
  type InviteResult,
} from './app';
import { isSessionRevoked, revokeAllForUser, revokeSession, type UserRow } from './data';
import { z } from 'zod';
import { hashPassword, passwordPolicy } from './password';

const app = createApp();

export default {
  fetch: (req: Request, env: Cloudflare.Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
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
    return isSessionRevoked(this.env.DB, sid);
  }

  // NOTE: no `issue(sid, aud)`. A Service Binding does not authenticate the caller, so any Worker in the account holding
  // the binding could mint a token for ANY product audience from a sid. Products get tokens over HTTP (`GET /token`, cookie
  // + allow-listed origin). Bring `issue` back only with a proof of possession (a token for the same sid) and a review.

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
   * Delete an identity (erasure, hard delete). Idempotent. Sessions, refresh tokens, codes and passkeys go with it (foreign
   * keys), so no token or refresh cookie of this user can ever be honoured again, and the Store cannot re-create its profile
   * row from a deleted identity (it reconciles only from an identity that still exists).
   */
  async eraseUser(userId: string): Promise<void> {
    z.string().uuid().parse(userId);
    await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM challenges WHERE user_id = ?1`).bind(userId),
      this.env.DB.prepare(`DELETE FROM users WHERE id = ?1`).bind(userId),
    ]);
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

  /** Mail a password-reset code (generic: silent for an unknown or inactive address). */
  async forgotPassword(email: string): Promise<void> {
    await forgotPasswordFor(
      this.env,
      z.string().trim().toLowerCase().email().max(254).parse(email)
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
