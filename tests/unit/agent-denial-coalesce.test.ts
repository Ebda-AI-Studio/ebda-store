/**
 * #1644 / #1649 (S5-mcp-agent-write-security, 2026-09-25 owner ruling).
 *
 * `auditAgentWrite` used to open its OWN `runInTenantContext` interactive
 * transaction for EVERY refused MCP write — reachable by a fully
 * unauthenticated caller (`POST /api/v1/mcp/:storeSlug` with no
 * `x-agent-key`), bounded only by `publicLimiter`'s 300/min/IP. A distributed
 * prober could hold up to 5 interactive transactions/sec/IP on the pool the
 * human checkout path shares, and grow `audit_logs` at the same rate — the
 * security control's own telemetry becoming the DoS surface.
 *
 * A FIRST attempt at this fix (2026-09-25, see docs/RULINGS.md) coalesced to
 * one row per window WITHOUT a count and was reverted the same day: it
 * silently dropped the repeats, which can defeat `classifyAgentDenials`'s
 * volume thresholds (a real 50-attempt flood would report as ~6 rows). This
 * version never drops the count: the FIRST denial in a (store, ip, tool,
 * credential) minute writes a durable row exactly as before (via
 * `runInTenantContext`);
 * every REPEAT in that window costs one plain, non-transactional `UPDATE` of
 * that row's `details.count` — never a new row, never a new transaction.
 * `agent.write.failed` (an AUTHORISED write that then threw) is never
 * coalesced — it requires credential possession and is not the
 * anonymous-flood surface this closes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuditLog = vi.fn().mockResolvedValue(undefined);
const mockAuditLogCreate = vi.fn();
const mockAuditLogUpdate = vi.fn().mockResolvedValue(undefined);
const mockIncrementRateLimit = vi.fn();
const mockIsAvailable = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    auditLog: {
      create: (...a: unknown[]) => mockAuditLogCreate(...a),
      update: (...a: unknown[]) => mockAuditLogUpdate(...a),
    },
  },
  runInTenantContext: vi.fn((_storeId: string, fn: () => unknown) => fn()),
}));

vi.mock('@api/middleware/security', () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    incrementRateLimit: (...a: unknown[]) => mockIncrementRateLimit(...a),
    isAvailable: () => mockIsAvailable(),
    getClient: () => ({
      get: (...a: unknown[]) => mockRedisGet(...a),
      set: (...a: unknown[]) => mockRedisSet(...a),
    }),
  },
}));

vi.mock('@api/services/encryption.service', () => ({ encryption: {} }));
vi.mock('@api/services/feature.service', () => ({ featureService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { auditAgentWrite, type McpAgentContext } from '@api/mcp/agent-auth';
import { classifyAgentDenials, type AgentDenialRow } from '@api/mcp/agent-denial-alerts';

const store = { id: 'store-1', name: 'Demo', slug: 'demo', currency: 'KWD', domain: null };

const context: McpAgentContext = {
  storeSlug: 'demo',
  ip: '198.51.100.9',
  userAgent: 'rogue-agent/2',
  requestId: 'req-1',
  credential: 'none',
  grant: 'denied',
};

/** In-memory fake for the `<key>:row` id cache — a real Redis GET/SET pair. */
function fakeRedisRowCache() {
  const store = new Map<string, string>();
  mockRedisSet.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  mockRedisGet.mockImplementation(async (key: string) => store.get(key) ?? null);
  return store;
}

/**
 * Replay the INSERTs and UPDATEs this module performed into the rows a watcher
 * tick would actually read back, shaped for `classifyAgentDenials` — the only
 * consumer that makes the coalescing correct or not.
 */
async function materialiseRows(): Promise<AgentDenialRow[]> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const result of mockAuditLogCreate.mock.results) {
    const row = (await result.value) as Record<string, unknown>;
    byId.set(row.id as string, { ...row });
  }
  for (const [call] of mockAuditLogUpdate.mock.calls as Array<
    [{ where: { id: string }; data: { details: Record<string, unknown> } }]
  >) {
    const row = byId.get(call.where.id);
    if (row) Object.assign(row, { details: call.data.details });
  }
  return [...byId.values()].map(row => {
    const details = (row.details ?? {}) as Record<string, unknown>;
    return {
      storeId: row.storeId as string,
      credential: details.credential as AgentDenialRow['credential'],
      ipAddress: row.ipAddress as string | null,
      tool: details.tool as string | null,
      count: details.count as number | undefined,
    };
  });
}

describe('#1644 / #1649 auditAgentWrite — denial coalescing WITH a count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockReturnValue(true);
    mockAuditLogCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `row-${mockAuditLogCreate.mock.calls.length}`,
      ...data,
    }));
  });

  it('writes a durable row (via runInTenantContext) on the first denial in a window, count=1', async () => {
    mockIncrementRateLimit.mockResolvedValue(1);

    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const created = mockAuditLogCreate.mock.calls[0][0].data;
    expect(created.action).toBe('agent.write.denied');
    expect(created.details.count).toBe(1);
    expect(mockAuditLogUpdate).not.toHaveBeenCalled();
  });

  it('50 denials in one minute produce exactly ONE row, with its count flushed to 50', async () => {
    fakeRedisRowCache();
    let n = 0;
    mockIncrementRateLimit.mockImplementation(async () => ++n);

    for (let i = 0; i < 50; i++) {
      await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });
    }

    // Exactly one INSERT (the first attempt) — every repeat is an UPDATE.
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogUpdate).toHaveBeenCalledTimes(49);

    // No information about volume is lost: the last flush carries the true
    // total, on the SAME row the first attempt created.
    const createdRow = await mockAuditLogCreate.mock.results[0].value;
    const lastUpdate = mockAuditLogUpdate.mock.calls.at(-1)?.[0];
    expect(lastUpdate.where.id).toBe(createdRow.id);
    expect(lastUpdate.data.details.count).toBe(50);
  });

  it('a repeat NEVER opens a transaction — runInTenantContext is not called for it', async () => {
    const db = await import('@force/database');
    fakeRedisRowCache();
    mockIncrementRateLimit.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });
    vi.mocked(db.runInTenantContext).mockClear();

    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });

    expect(db.runInTenantContext).not.toHaveBeenCalled();
    expect(mockAuditLogUpdate).toHaveBeenCalledTimes(1);
  });

  it('keys the coalescing by store + ip + tool — a different tool gets its OWN row', async () => {
    fakeRedisRowCache();
    // add_to_cart is already mid-window (count 5)...
    mockIncrementRateLimit.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':add_to_cart:') ? 5 : 1)
    );

    await auditAgentWrite({ store, tool: 'place_order', outcome: 'denied', context });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate.mock.calls[0][0].data.details.count).toBe(1);
  });

  it('a different ip within the same store/tool also gets its own row', async () => {
    fakeRedisRowCache();
    mockIncrementRateLimit.mockImplementation((key: string) =>
      Promise.resolve(key.includes(':198.51.100.9:') ? 3 : 1)
    );

    await auditAgentWrite({
      store,
      tool: 'add_to_cart',
      outcome: 'denied',
      context: { ...context, ip: '203.0.113.5' },
    });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate.mock.calls[0][0].data.details.count).toBe(1);
  });

  it('a different store also gets its own row even for the same ip/tool', async () => {
    fakeRedisRowCache();
    mockIncrementRateLimit.mockImplementation((key: string) =>
      Promise.resolve(key.startsWith('agent:denied:store-1:') ? 4 : 1)
    );

    await auditAgentWrite({
      store: { ...store, id: 'store-2' },
      tool: 'add_to_cart',
      outcome: 'denied',
      context,
    });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate.mock.calls[0][0].data.details.count).toBe(1);
  });

  it('falls back to ONE ROW PER ATTEMPT when Redis is unavailable — never drops an attempt', async () => {
    mockIsAvailable.mockReturnValue(false);
    mockIncrementRateLimit.mockResolvedValue(0); // real incrementRateLimit's fail-open value

    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });
    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });
    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(3);
    expect(mockAuditLogUpdate).not.toHaveBeenCalled();
    for (const call of mockAuditLogCreate.mock.calls) {
      expect(call[0].data.details.count).toBe(1);
    }
  });

  it('self-heals when the cached row id cannot be found: writes a fresh row rather than dropping the attempt', async () => {
    // Redis says this is attempt #2, but the row-id cache has nothing for
    // this window (e.g. it evicted independently of the counter, or the
    // update below failed) — must not silently lose the attempt.
    mockIncrementRateLimit.mockResolvedValue(2);
    mockRedisGet.mockResolvedValue(null);

    await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    // count=1, NOT the counter's 2: attempt #1 was already recorded on the row
    // this window lost the pointer to. Stamping the replacement row with the
    // cumulative counter would count attempt #1 a second time — the flood
    // double-count the test below pins.
    expect(mockAuditLogCreate.mock.calls[0][0].data.details.count).toBe(1);
  });

  // The counter and the row pointer have DIFFERENT lifetimes.
  // `redis.incrementRateLimit` re-EXPIREs on every call, so the counter is
  // inactivity-based and never expires while attempts keep arriving; the
  // `<key>:row` pointer carries a fixed `EX 60` from its row's creation and is
  // not refreshed. So a continuous prober outlives its pointer with the
  // counter still climbing. Stamping the replacement row with the raw counter
  // made every row carry the CUMULATIVE total (300, 600, 900 …): ~4,500 real
  // attempts materialised as ~36,000 weighted ones, which crosses the p0/p1
  // thresholds at a fraction of the real rate (a false page) and misreports
  // the number the operator sizes the incident from.
  it('does not double-count when the row pointer expires under a still-climbing counter', async () => {
    const cache = fakeRedisRowCache();
    let n = 0;
    mockIncrementRateLimit.mockImplementation(async () => ++n);

    const ATTEMPTS = 900;
    for (let i = 0; i < ATTEMPTS; i++) {
      // The pointer's fixed TTL lapses once per 300 attempts (a 300/min
      // prober); the counter, re-EXPIREd on every INCR, does not.
      if (i > 0 && i % 300 === 0) cache.clear();
      await auditAgentWrite({ store, tool: 'add_to_cart', outcome: 'denied', context });
    }

    // One row per lapsed pointer — and their counts SUM to the real attempts,
    // rather than each restating the whole counter.
    const rows = await materialiseRows();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.count)).toEqual([300, 300, 300]);
    expect(rows.reduce((sum, r) => sum + (r.count ?? 0), 0)).toBe(ATTEMPTS);
  });

  // `classifyAgentDenials` partitions rows by `details.credential`, so the
  // coalescing key must be at least as fine-grained as that partition. When it
  // was only (store, ip, tool), a repeat rewrote the surviving row's `details`
  // wholesale with the CURRENT attempt's credential while its `count` kept
  // summing the WHOLE window: 49 `invalid` attempts followed by one key-less
  // one collapsed to `credential: 'none', count: 50`, which classifies as an
  // `info` anonymous flood — the p1 that exists to catch exactly that flood
  // never fired. Same mechanism could bury `error` (the p0 platform fault).
  it('does not let a later credential shape absorb an earlier one — the p1 still fires', async () => {
    fakeRedisRowCache();
    const counters = new Map<string, number>();
    mockIncrementRateLimit.mockImplementation(async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    });

    // A merchant integration hammering with a rotated key...
    for (let i = 0; i < 49; i++) {
      await auditAgentWrite({
        store,
        tool: 'place_order',
        outcome: 'denied',
        context: { ...context, credential: 'invalid' },
      });
    }
    // ...then one crawler with no header at all, LAST in the window.
    await auditAgentWrite({
      store,
      tool: 'place_order',
      outcome: 'denied',
      context: { ...context, credential: 'none' },
    });

    const rows = await materialiseRows();
    expect(rows).toHaveLength(2);

    const findings = classifyAgentDenials(rows);
    const broken = findings.find(f => f.kind === 'integration_broken');
    expect(broken?.level).toBe('p1');
    expect(broken?.count).toBe(49);
    // The one anonymous attempt is its own row and nowhere near its threshold.
    expect(findings.some(f => f.kind === 'anonymous_flood')).toBe(false);
  });

  it('never dedupes `failed` — an authorised write that then threw is not the anonymous-flood surface', async () => {
    mockIncrementRateLimit.mockResolvedValue(999);

    await auditAgentWrite({ store, tool: 'place_order', outcome: 'failed', context });
    await auditAgentWrite({ store, tool: 'place_order', outcome: 'failed', context });

    expect(mockAuditLog).toHaveBeenCalledTimes(2);
    expect(mockIncrementRateLimit).not.toHaveBeenCalled();
    expect(mockAuditLogCreate).not.toHaveBeenCalled();
  });
});
