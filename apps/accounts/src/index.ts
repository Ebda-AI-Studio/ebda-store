import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApp } from './app';
import { findUserById, isSessionRevoked, revokeAllForUser, revokeSession } from './data';
import { mintAccessToken } from './jwt';
import { hashPassword, passwordPolicy } from './password';
import { iso } from './util';

const app = createApp();

export default {
  fetch: (req: Request, env: Cloudflare.Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Cloudflare.Env>;

/**
 * Service Binding RPC for the products (token contract: `Accounts.isRevoked(sid)`, `Accounts.issue(sid, aud)`).
 * A Service Binding is wired in wrangler config of the CALLING Worker, so only Workers we deploy can reach this.
 */
export class Accounts extends WorkerEntrypoint<Cloudflare.Env> {
  async isRevoked(sid: string): Promise<boolean> {
    return isSessionRevoked(this.env.DB, sid);
  }

  /** Mint an access token for a live session (server-side, no cookie involved). */
  async issue(
    sid: string,
    aud: string
  ): Promise<{ access_token: string; expires_at: number } | null> {
    if (!this.env.PRODUCTS.split(',').includes(aud)) return null;
    if (await isSessionRevoked(this.env.DB, sid)) return null;
    const s = await this.env.DB.prepare(`SELECT user_id FROM sessions WHERE sid = ?1`)
      .bind(sid)
      .first<{ user_id: string }>();
    const user = s ? await findUserById(this.env.DB, s.user_id) : null;
    if (!user) return null;
    const stores = this.env.STORE_DIRECTORY
      ? await this.env.STORE_DIRECTORY.storesForUser(user.id)
      : [];
    const { token, expiresAt } = await mintAccessToken(this.env, {
      sub: user.id,
      sid,
      aud,
      stores,
      ...(user.role === 'super_admin' ? { pa: 'super_admin' as const } : {}),
      email: user.email,
      email_verified: !!user.email_verified,
    });
    return { access_token: token, expires_at: expiresAt };
  }

  /** Revoke every session of a user (suspension, password change by an admin, erasure). */
  async revokeUser(userId: string, reason: string): Promise<void> {
    await revokeAllForUser(this.env.DB, userId, reason.slice(0, 80));
  }

  async revokeSession(sid: string, reason: string): Promise<void> {
    await revokeSession(this.env.DB, sid, reason.slice(0, 80));
  }

  /** Create a merchant identity for the Store's provisioning flow. Returns null when the email is taken. */
  async createUser(input: {
    id?: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    language?: 'en' | 'ar';
    role?: 'store_admin' | 'staff';
  }): Promise<{ id: string } | null> {
    passwordPolicy.parse(input.password);
    const id = input.id ?? crypto.randomUUID();
    try {
      await this.env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'active',0,?7,?8,?8)`
      )
        .bind(
          id,
          input.email.trim().toLowerCase(),
          await hashPassword(input.password),
          input.firstName,
          input.lastName,
          input.role ?? 'store_admin',
          input.language ?? 'en',
          iso()
        )
        .run();
      return { id };
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message)) return null;
      throw e;
    }
  }
}
