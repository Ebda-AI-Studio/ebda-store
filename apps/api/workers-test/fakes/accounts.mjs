// Test-only stand-in for the identity service (apps/accounts) behind the `ACCOUNTS` Service Binding, loaded only by the
// route sweep (vitest.workers.config.mts). Every account it is asked about is an active, MFA-enrolled super_admin: the sweep
// measures which routes still need Postgres, not the identity service.
import { WorkerEntrypoint } from 'cloudflare:workers';

// An account id with this prefix is a super_admin in the fake (security tests of the admin user edit).
const SUPER_TARGET_PREFIX = '00000000-0000-4000-8000-0000000000aa';

export default class FakeAccounts extends WorkerEntrypoint {
  async fetch() {
    return new Response(JSON.stringify({ keys: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  async getAccountState(userId) {
    return {
      id: userId,
      email: `${userId}@exit-test.invalid`,
      emailVerified: true,
      mfaEnabled: true,
      mfaEnrolledAt: new Date(0).toISOString(),
      status: 'active',
      role: 'super_admin',
      firstName: 'Sweep',
      lastName: 'Admin',
      phone: null,
      language: 'en',
    };
  }
  async getAccountsBrief(userIds) {
    return userIds.map(id => ({
      id,
      email: `${id}@exit-test.invalid`,
      firstName: 'Sweep',
      lastName: 'User',
      status: 'active',
      role: id.startsWith(SUPER_TARGET_PREFIX) ? 'super_admin' : 'store_admin',
      lastLoginAt: null,
      createdAt: new Date(0).toISOString(),
    }));
  }
  async inviteUser(input) {
    return { id: input.id, created: true };
  }
  async eraseUser() {
    return { erased: true, remaining: 0 };
  }
  async revokeUser() {}
  async revokeSession() {}
  async isRevoked() {
    return false;
  }
  async setStatus() {}
  async updateProfile(userId, _input, _reason, actorId) {
    if (userId.startsWith(SUPER_TARGET_PREFIX) && actorId !== userId)
      return { ok: false, code: 'FORBIDDEN_TARGET' };
    return { ok: true };
  }
}
