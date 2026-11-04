// Test-only stand-in for the identity service (apps/accounts) behind the `ACCOUNTS` Service Binding, loaded only by the
// route sweep (vitest.workers.config.mts). Every account it is asked about is an active, MFA-enrolled super_admin: the sweep
// measures which routes still need Postgres, not the identity service.
import { WorkerEntrypoint } from 'cloudflare:workers';

export default class FakeAccounts extends WorkerEntrypoint {
  async fetch() {
    return new Response(JSON.stringify({ keys: [] }), { headers: { 'content-type': 'application/json' } });
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
      role: 'store_admin',
      lastLoginAt: null,
      createdAt: new Date(0).toISOString(),
    }));
  }
  async revokeUser() {}
  async revokeSession() {}
  async isRevoked() {
    return false;
  }
  async setStatus() {}
}
