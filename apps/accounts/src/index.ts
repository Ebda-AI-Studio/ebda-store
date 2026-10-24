import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApp } from './app';
import { isSessionRevoked, revokeAllForUser, revokeSession } from './data';
import { z } from 'zod';
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

  // NOTE: no `issue(sid, aud)`. A Service Binding does not authenticate the caller, so any Worker in the account holding
  // the binding could mint a token for ANY product audience from a sid. Products get tokens over HTTP (`GET /token`, cookie
  // + allow-listed origin). Bring `issue` back only with a proof of possession (a token for the same sid) and a review.

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
    const email = z.string().trim().toLowerCase().email().max(254).parse(input.email);
    if (input.id !== undefined) z.string().uuid().parse(input.id);
    const id = input.id ?? crypto.randomUUID();
    try {
      await this.env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, role, status, email_verified, language, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'active',0,?7,?8,?8)`
      )
        .bind(
          id,
          email,
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
      // Only an email collision means "taken"; an id collision is a caller bug and must not be reported as one.
      if (/UNIQUE.*users\.email|users_email_lower/i.test((e as Error).message)) return null;
      throw e;
    }
  }
}
