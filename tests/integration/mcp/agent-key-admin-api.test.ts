/**
 * End-to-end lifecycle of the agent (MCP) write credential, driven exactly the
 * way the new `/stores/[id]/agent-key` merchant page drives it: over HTTP, with
 * a real store_admin session, against a real running API — then checked at the
 * MCP endpoint with a real MCP client.
 *
 * `tests/unit/agent-credential-route.test.ts` proves the handlers' shape with a
 * mocked Prisma. This proves the two things a mock cannot:
 *
 *   1. **Revoke actually invalidates.** Minting through the admin API produces a
 *      key that authorises an MCP write; DELETE-ing through the admin API makes
 *      the SAME key stop working on the very next call. The existing
 *      `agent-checkout.test.ts` covers a revoked key by nulling the column
 *      directly; nothing covered the merchant-facing path that does the nulling,
 *      which is the path the new UI uses.
 *   2. **A wide store read still does not carry the credential.** `GET
 *      /stores/:id` and `GET /stores` hand whole Store rows to the admin app.
 *      The parent PR added `omit: { agentApiKey: true }` at those service
 *      boundaries after the sweep found the ciphertext riding out; this asserts
 *      it against the live response, with a key ACTUALLY ISSUED — the state in
 *      which the leak is possible at all.
 *
 * Requires a real Postgres (DATABASE_URL) and Redis, and a running API at
 * API_URL (default http://localhost:4000/api/v1) — same setup contract as
 * `agent-checkout.test.ts`.
 *
 * RETRY-SAFETY: vitest runs with `retry: 1` and re-runs `beforeAll` in the SAME
 * process, so every fixture id is built from a per-CALL `randomUUID()`. There is
 * no module-scope `Date.now()` here, deliberately — a per-file id collides on
 * `Store.slug` / `User.email` on the second attempt and reports an artefact of
 * attempt 2 while hiding the real failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@ebda/database';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_BASE } from '../../helpers/api-base';
import { identityTokenFor } from '../../helpers/identity-session';

const API = API_BASE;

/** Per-CALL unique id. NEVER hoist into a module-scope constant — see above. */
const uid = () => randomUUID().slice(0, 12);

let storeId: string;
let ownerId: string;
let slug: string;
let productId: string;
let adminToken: string;
let adminEmail: string;

const ADMIN_PASSWORD = 'TestAdmin!1';

function auth() {
  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

function keyEndpoint() {
  return `${API}/stores/${storeId}/integrations/agent-key`;
}

/** `agentKey` omitted = exactly the request an unauthenticated agent makes. */
async function mcpClient(agentKey?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp/${slug}`), {
    requestInit: agentKey ? { headers: { 'x-agent-key': agentKey } } : undefined,
  });
  const client = new Client({ name: 'agent-key-admin-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** One write attempt with the given key. Returns whether it was allowed. */
async function writeAllowedWith(agentKey?: string): Promise<boolean> {
  const client = await mcpClient(agentKey);
  try {
    const res = await client.callTool({
      name: 'add_to_cart',
      arguments: { cartId: `sess_${uid()}`, productId, quantity: 1 },
    });
    return res.isError !== true;
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  slug = `agentkey-store-${uid()}`;
  adminEmail = `agentkey-admin-${uid()}@example.test`;

  const owner = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      firstName: 'Agent',
      lastName: 'Key',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  ownerId = owner.id;

  const store = await prisma.store.create({
    data: {
      name: 'Agent Key Store',
      slug,
      ownerId,
      plan: 'enterprise',
      status: 'active',
      currency: 'EGP',
    },
  });
  storeId = store.id;

  await prisma.storeFeature.upsert({
    where: { storeId_featureKey: { storeId, featureKey: 'agent_checkout' } },
    create: { storeId, featureKey: 'agent_checkout', enabled: true },
    update: { enabled: true },
  });

  const product = await prisma.product.create({
    data: {
      storeId,
      name: 'Key Test Widget',
      slug: `ktw-${uid()}`,
      status: 'active',
      price: 1500,
      inventory: 50,
    },
  });
  productId = product.id;

  // A store_admin signs in at the identity service; the suite presents the token it would issue (tests/helpers/identity-session.ts).
  adminToken = await identityTokenFor(ownerId);
  expect(
    adminToken,
    'store_admin identity token must be minted for this suite to mean anything'
  ).toBeTruthy();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.cartItem.deleteMany({ where: { cart: { storeId } } }).catch(() => {});
  await prisma.cart.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.product.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.storeFeature.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
});

describe('agent key admin API — the merchant lifecycle', () => {
  it('starts with no key, and the status endpoint says so without leaking anything', async () => {
    const res = await fetch(keyEndpoint(), { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hasKey).toBe(false);
    expect(body.data.rotatedAt).toBeNull();
    expect(body.data.header).toBe('x-agent-key');
    expect(body.data.openWrites).toBe(false);
  });

  it('mint returns the plaintext key EXACTLY ONCE and never again', async () => {
    const minted = await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    expect(minted.status).toBe(201);
    const mintBody = await minted.json();
    const key = mintBody.data.apiKey as string;
    expect(key).toMatch(/^fak_/);
    expect(mintBody.data.rotated).toBe(false);

    // The stored value is the ciphertext, not the key.
    const row = await prisma.storeCredential.findUnique({
      where: { storeId },
      select: { agentApiKey: true },
    });
    const stamp = await prisma.store.findUnique({
      where: { id: storeId },
      select: { agentApiKeyRotatedAt: true },
    });
    expect(row?.agentApiKey).toBeTruthy();
    expect(row?.agentApiKey).not.toBe(key);
    expect(stamp?.agentApiKeyRotatedAt).toBeInstanceOf(Date);

    // And no read after the mint can produce it.
    const status = await fetch(keyEndpoint(), { headers: auth() });
    const statusBody = await status.json();
    expect(statusBody.data.hasKey).toBe(true);
    expect(JSON.stringify(statusBody)).not.toContain(key);
    expect(statusBody.data.apiKey).toBeUndefined();

    // A second GET is not a second chance either.
    const again = await fetch(keyEndpoint(), { headers: auth() });
    expect(JSON.stringify(await again.json())).not.toContain(key);
  });

  it('a wide store read does not expose the credential, with a key issued', async () => {
    // The regression the parent PR's sweep caught. Asserted here in the ONLY
    // state where the leak is possible — after a key exists.
    const one = await fetch(`${API}/stores/${storeId}`, { headers: auth() });
    expect(one.status).toBe(200);
    const oneBody = await one.json();
    expect(oneBody.data.store.id).toBe(storeId);
    expect(oneBody.data.store.agentApiKey).toBeUndefined();
    // `"agentApiKey"` quoted, so the assertion is not satisfied by the sibling
    // `agentApiKeyRotatedAt` — which IS returned, deliberately: a rotation
    // timestamp is not a secret and the merchant page renders it.
    expect(JSON.stringify(oneBody)).not.toContain('"agentApiKey"');

    const list = await fetch(`${API}/stores`, { headers: auth() });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    const mine = listBody.data.stores.find((s: { id: string }) => s.id === storeId);
    expect(
      mine,
      'the store under test must be in the list for this to assert anything'
    ).toBeTruthy();
    expect(mine.agentApiKey).toBeUndefined();
    expect(JSON.stringify(listBody)).not.toContain('"agentApiKey"');
  });

  it('no store read returns ANY stored credential — the global omit covers it (2026-09-25)', async () => {
    // GET /admin/stores/:id ran a bare findUnique + include and shipped every
    // ciphertext column to the admin client (Ruling M5 residual). Set the
    // credential so the leak is possible, then read every wide store endpoint.
    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: 'ciphertext-agent' },
      update: { agentApiKey: 'ciphertext-agent' },
    });
    for (const path of [`/admin/stores/${storeId}`, `/stores/${storeId}`, '/stores']) {
      const res = await fetch(`${API}${path}`, { headers: auth() });
      expect(res.status, path).toBe(200);
      const raw = JSON.stringify(await res.json());
      for (const field of ['"agentApiKey"']) {
        expect(raw, `${path} must not return ${field}`).not.toContain(field);
      }
    }
    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: null },
      update: { agentApiKey: null },
    });
  });

  it('a store UPDATE response does not echo any stored credential either (#1651)', async () => {
    // The PUT writers (theme/branding/social/contact/announcement/...) return
    // the raw `prisma.store.update` row, which store.routes.ts serialises
    // verbatim. Only the global omit keeps the ciphertexts out of it.
    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: 'ciphertext-agent' },
      update: { agentApiKey: 'ciphertext-agent' },
    });
    const minted = await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    expect(minted.status).toBe(201);

    const res = await fetch(`${API}/stores/${storeId}/announcement`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ enabled: false, text: 'hello', textAr: 'مرحبا' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.store.id, 'the update must return the store row').toBe(storeId);
    const raw = JSON.stringify(body);
    for (const field of ['"agentApiKey"']) {
      expect(raw, `PUT /announcement must not return ${field}`).not.toContain(field);
    }

    await fetch(keyEndpoint(), { method: 'DELETE', headers: auth() });
    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: null },
      update: { agentApiKey: null },
    });
  });

  it('an explicit select still reads the omitted credential back (#1938)', async () => {
    // The global omit is only safe because a query-level `select` overrides
    // it: guards like `if (!credentials.agentApiKey) return;` would turn
    // into SILENT no-ops if it did not.
    const creds = { agentApiKey: 'ciphertext-agent' };
    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, ...creds },
      update: creds,
    });
    const row = await prisma.storeCredential.findUnique({
      where: { storeId },
      select: { agentApiKey: true },
    });
    expect(row).toEqual({ agentApiKey: 'ciphertext-agent' });
    // Negative control: without the select the same row carries none of them.
    const bare = await prisma.storeCredential.findUnique({ where: { storeId } });
    expect(bare).not.toHaveProperty('agentApiKey');

    await prisma.storeCredential.upsert({
      where: { storeId },
      create: { storeId, agentApiKey: null },
      update: { agentApiKey: null },
    });
  });

  it('a minted key authorises an MCP write; revoking it refuses the very next one', async () => {
    // Fresh mint so this test owns its own key regardless of order.
    const minted = await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    const key = (await minted.json()).data.apiKey as string;

    expect(await writeAllowedWith(key)).toBe(true);

    const revoked = await fetch(keyEndpoint(), { method: 'DELETE', headers: auth() });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.hasKey).toBe(false);

    // The column is actually cleared — not merely re-stamped.
    const row = await prisma.storeCredential.findUnique({
      where: { storeId },
      select: { agentApiKey: true },
    });
    expect(row?.agentApiKey).toBeNull();

    // The same key, one call later.
    expect(await writeAllowedWith(key)).toBe(false);

    const status = await fetch(keyEndpoint(), { headers: auth() });
    expect((await status.json()).data.hasKey).toBe(false);
  });

  it('rotating invalidates the previous key immediately, with no overlap window', async () => {
    const first = await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    const oldKey = (await first.json()).data.apiKey as string;
    expect(await writeAllowedWith(oldKey)).toBe(true);

    const second = await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    const secondBody = await second.json();
    const newKey = secondBody.data.apiKey as string;
    expect(secondBody.data.rotated).toBe(true);
    expect(newKey).not.toBe(oldKey);

    expect(await writeAllowedWith(newKey)).toBe(true);
    expect(await writeAllowedWith(oldKey)).toBe(false);
  });

  it('records an audit row for issue and for revoke', async () => {
    await fetch(keyEndpoint(), { method: 'POST', headers: auth() });
    await fetch(keyEndpoint(), { method: 'DELETE', headers: auth() });

    const actions = await prisma.auditLog.findMany({
      where: { storeId, action: { in: ['store.agent_key_issued', 'store.agent_key_revoked'] } },
      select: { action: true, userId: true, details: true },
    });
    expect(actions.some(a => a.action === 'store.agent_key_issued')).toBe(true);
    expect(actions.some(a => a.action === 'store.agent_key_revoked')).toBe(true);
    expect(actions.every(a => a.userId === ownerId)).toBe(true);
    // No audit row may carry the secret.
    expect(JSON.stringify(actions)).not.toContain('fak_');
  });

  it('read tools keep working with no credential at all, before and after a revoke', async () => {
    // The property the whole read/write split exists to protect. If this ever
    // fails, the credential requirement has escaped into the read surface.
    const client = await mcpClient();
    try {
      const info = await client.callTool({ name: 'get_store_info', arguments: {} });
      expect(info.isError).toBeFalsy();
      const search = await client.callTool({
        name: 'search_products',
        arguments: { query: 'Key' },
      });
      expect(search.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});

describe('agent key admin API — authorisation', () => {
  it('refuses an unauthenticated caller on every verb', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await fetch(keyEndpoint(), { method });
      expect([401, 403], `${method} without a session`).toContain(res.status);
    }
  });

  it("refuses another store_admin's session on this store", async () => {
    const otherEmail = `agentkey-other-${uid()}@example.test`;
    const other = await prisma.user.create({
      data: {
        email: otherEmail,
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
        firstName: 'Other',
        lastName: 'Admin',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    try {
      const token = await identityTokenFor(other.id);
      expect(token).toBeTruthy();

      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await fetch(keyEndpoint(), {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        expect([403, 404], `${method} as a foreign store_admin`).toContain(res.status);
      }
    } finally {
      await prisma.user.delete({ where: { id: other.id } }).catch(() => {});
    }
  });
});
