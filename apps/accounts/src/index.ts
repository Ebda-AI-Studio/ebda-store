import { WorkerEntrypoint } from 'cloudflare:workers';
import { createApp, registerPending } from './app';
import { isSessionRevoked, revokeAllForUser, revokeSession } from './data';
import { z } from 'zod/v3';
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
