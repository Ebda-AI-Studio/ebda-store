/**
 * Gate chain every merchant-MCP WRITE tool goes through (merchant-write.ts),
 * proven WITHOUT a database: a throwaway tool is registered through the real
 * `registerMerchantWriteTool` and its handler is called directly. Covers:
 *   permitted write · wrong-store key (403) · foreign target (403, no oracle) ·
 *   unconfirmed destructive refused · token replay refused · token for different
 *   args refused · disabled plan refused · store toggle off refused · RBAC refused ·
 *   audit row actor=mcp · audit failure FAILS CLOSED (mutation never runs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  settings: vi.fn(),
  insertAuditLog: vi.fn(),
  auditLog: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('@api/config', () => ({
  config: { encryptionKey: 'test-encryption-key-0123456789abcdef' },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  runInTenantContext: async (_id: string, fn: () => unknown) => fn(),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: m.settings } }),
}));
vi.mock('@api/lib/definer', () => ({
  insertAuditLog: m.insertAuditLog,
  getUserState: vi.fn(),
}));
vi.mock('@api/middleware/error-handler', () => ({
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: m.auditLog }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    getClient: () => ({ set: m.redisSet }),
  },
}));

import { registerMerchantWriteTool, type WriteToolSpec } from '@api/mcp/merchant-write';
import { MERCHANT_SCOPES, type MerchantAuth } from '@api/mcp/merchant-auth';
import { AppError } from '@api/middleware/error-handler';

const STORE = { id: 'store-a', name: 'A', slug: 'a', currency: 'EGP', domain: null };

type Handler = (args: Record<string, unknown>, extra: { authInfo: MerchantAuth }) => Promise<any>;

function register(spec: WriteToolSpec<any>): Handler {
  let handler!: Handler;
  registerMerchantWriteTool(
    { registerTool: (_n: string, _d: unknown, h: Handler) => (handler = h) } as any,
    STORE,
    spec
  );
  return handler;
}

function auth(over: Partial<MerchantAuth> = {}): MerchantAuth {
  return {
    token: 'fp',
    clientId: 'key-1',
    keyId: 'key-1',
    userId: 'user-1',
    role: 'store_admin',
    storeId: 'store-a',
    scopes: [MERCHANT_SCOPES.write, MERCHANT_SCOPES.destructive],
    ip: '203.0.113.5',
    userAgent: 'vitest',
    ...over,
  } as MerchantAuth;
}

const mutate = vi.fn();
const plain: WriteToolSpec<any> = {
  name: 'test_write',
  description: 'd',
  input: { id: z.string() },
  permission: 'products:write',
  audit: { action: 'thing.updated', resourceType: 'thing', resourceId: a => a.id },
  run: async a => {
    mutate(a);
    return { id: a.id };
  },
};
const destructive: WriteToolSpec<any> = {
  name: 'test_delete',
  description: 'd',
  input: { id: z.string() },
  destructive: true,
  permission: 'products:delete',
  audit: { action: 'thing.deleted', resourceType: 'thing', resourceId: a => a.id },
  summarize: async a => `delete ${a.id}`,
  run: async a => {
    mutate(a);
    return { id: a.id, deleted: true };
  },
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  mutate.mockReset();
  m.featureEnabled.mockResolvedValue(true);
  m.settings.mockResolvedValue({ settings: {} });
  m.insertAuditLog.mockResolvedValue(undefined);
  m.auditLog.mockResolvedValue(undefined);
  m.redisSet.mockResolvedValue('OK');
});

describe('permitted write', () => {
  it('runs the mutation and writes intent + completed audit rows with actor=mcp', async () => {
    const h = register(plain);
    const res = await h({ id: 't1' }, { authInfo: auth() });
    expect(JSON.parse(res.content[0].text)).toEqual({ id: 't1' });
    expect(mutate).toHaveBeenCalledTimes(1);

    const intent = m.insertAuditLog.mock.calls[0][0];
    expect(intent).toMatchObject({
      action: 'thing.updated',
      userId: 'user-1',
      storeId: 'store-a',
      resourceId: 't1',
    });
    expect(intent.details).toMatchObject({ actor: 'mcp', keyId: 'key-1', phase: 'intent' });
    expect(m.auditLog.mock.calls[0][0].details).toMatchObject({ actor: 'mcp', phase: 'completed' });
  });
});

describe('store scope', () => {
  it('refuses (403) a key that belongs to another store', async () => {
    const h = register(plain);
    await expect(h({ id: 't1' }, { authInfo: auth({ storeId: 'store-b' }) })).rejects.toThrow(
      /FORBIDDEN.*does not belong/
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it('turns a service 404 (foreign or missing id) into the same FORBIDDEN, no oracle', async () => {
    const h = register({
      ...plain,
      run: async () => {
        throw new AppError(404, 'NOT_FOUND', 'Order not found');
      },
    });
    await expect(h({ id: 'other-store-id' }, { authInfo: auth() })).rejects.toThrow(
      /FORBIDDEN.*not found in this store/
    );
    // the failed attempt is still audited
    expect(m.auditLog.mock.calls[0][0].details).toMatchObject({ phase: 'failed', actor: 'mcp' });
  });

  it('a foreign target is refused before a destructive token is minted', async () => {
    const h = register({
      ...destructive,
      summarize: async () => {
        throw new AppError(404, 'NOT_FOUND', 'nope');
      },
    });
    await expect(h({ id: 'x' }, { authInfo: auth() })).rejects.toThrow(/FORBIDDEN/);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('scope, RBAC, entitlement, switch', () => {
  it('refuses a key without the write scope', async () => {
    const h = register(plain);
    await expect(
      h({ id: 't' }, { authInfo: auth({ scopes: [MERCHANT_SCOPES.read] }) })
    ).rejects.toThrow(/FORBIDDEN/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses when the key owner lacks the admin route permission (staff cannot delete products)', async () => {
    const h = register(destructive);
    await expect(h({ id: 't' }, { authInfo: auth({ role: 'staff' }) })).rejects.toThrow(
      /products:delete/
    );
  });

  it('refuses a key owned by a platform super_admin (ORDER-MONEY-SUPERADMIN)', async () => {
    const h = register(plain);
    await expect(h({ id: 't' }, { authInfo: auth({ role: 'super_admin' }) })).rejects.toThrow(
      /super-admin/
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses on a plan without MCP writes (merchant_mcp_write off)', async () => {
    m.featureEnabled.mockImplementation(
      async (_s: string, k: string) => k !== 'merchant_mcp_write'
    );
    const h = register(plain);
    await expect(h({ id: 't' }, { authInfo: auth() })).rejects.toThrow(/Growth or Business/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses when the merchant switched MCP writes off for the store', async () => {
    m.settings.mockResolvedValue({ settings: { mcpWriteEnabled: false } });
    const h = register(plain);
    await expect(h({ id: 't' }, { authInfo: auth() })).rejects.toThrow(
      /turned MCP write tools off/
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it("refuses when the route's own feature (e.g. coupons) is off for the store", async () => {
    m.featureEnabled.mockImplementation(async (_s: string, k: string) => k !== 'coupons');
    const h = register({ ...plain, feature: 'coupons' });
    await expect(h({ id: 't' }, { authInfo: auth() })).rejects.toThrow(/"coupons" feature/);
  });
});

describe('destructive confirm round-trip', () => {
  it('first call changes nothing and returns a token + summary', async () => {
    const h = register(destructive);
    const first = JSON.parse((await h({ id: 't1' }, { authInfo: auth() })).content[0].text);
    expect(first).toMatchObject({ confirmationRequired: true, summary: 'delete t1' });
    expect(typeof first.confirmToken).toBe('string');
    expect(mutate).not.toHaveBeenCalled();
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it('second call with the token executes once; replaying the same token is refused', async () => {
    const h = register(destructive);
    const { confirmToken } = JSON.parse(
      (await h({ id: 't1' }, { authInfo: auth() })).content[0].text
    );

    m.redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null); // NX: first wins
    const done = JSON.parse(
      (await h({ id: 't1', confirmToken }, { authInfo: auth() })).content[0].text
    );
    expect(done).toEqual({ id: 't1', deleted: true });
    expect(mutate).toHaveBeenCalledTimes(1);

    await expect(h({ id: 't1', confirmToken }, { authInfo: auth() })).rejects.toThrow(
      /already used/
    );
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('a token minted for different arguments does not confirm (a new token is issued instead)', async () => {
    const h = register(destructive);
    const { confirmToken } = JSON.parse(
      (await h({ id: 't1' }, { authInfo: auth() })).content[0].text
    );
    const res = JSON.parse(
      (await h({ id: 't2', confirmToken }, { authInfo: auth() })).content[0].text
    );
    expect(res.confirmationRequired).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('a token minted for another key/actor does not confirm', async () => {
    const h = register(destructive);
    const { confirmToken } = JSON.parse(
      (await h({ id: 't1' }, { authInfo: auth() })).content[0].text
    );
    const res = JSON.parse(
      (
        await h(
          { id: 't1', confirmToken },
          { authInfo: auth({ keyId: 'key-2', clientId: 'key-2' }) }
        )
      ).content[0].text
    );
    expect(res.confirmationRequired).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refuses to execute when the single-use store is down (fail closed)', async () => {
    const h = register(destructive);
    const { confirmToken } = JSON.parse(
      (await h({ id: 't1' }, { authInfo: auth() })).content[0].text
    );
    m.redisSet.mockRejectedValue(new Error('redis down'));
    await expect(h({ id: 't1', confirmToken }, { authInfo: auth() })).rejects.toThrow(
      /NOT performed/
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('audit fails closed', () => {
  it('does NOT run the mutation when the intent audit row cannot be written', async () => {
    m.insertAuditLog.mockRejectedValue(new Error('db down'));
    const h = register(plain);
    await expect(h({ id: 't1' }, { authInfo: auth() })).rejects.toThrow(
      /audit log could not be written/
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('a destructive confirm does not burn the token when the audit write fails', async () => {
    const h = register(destructive);
    const { confirmToken } = JSON.parse(
      (await h({ id: 't1' }, { authInfo: auth() })).content[0].text
    );
    m.insertAuditLog.mockRejectedValue(new Error('db down'));
    await expect(h({ id: 't1', confirmToken }, { authInfo: auth() })).rejects.toThrow(/audit log/);
    expect(m.redisSet).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
