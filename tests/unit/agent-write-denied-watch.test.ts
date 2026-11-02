/**
 * The denial watcher is actually WIRED — it reads the right rows and dispatches
 * what the classifier decides.
 *
 * `agent-denial-alerts.test.ts` proves the decision. This proves the decision
 * reaches Telegram: a correct classifier that nothing calls, or that is called
 * with the wrong `action`, the wrong window, or under RLS (which returns zero
 * rows in an Inngest worker, forever), is an alert that never fires — and an
 * alert that never fires looks exactly like a quiet system.
 *
 * Both directions again: below threshold the function must send NOTHING.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAuditFindMany, mockAuditGroupBy, mockAuditCount, mockOrderFindMany, mockSendAlert } =
  vi.hoisted(() => {
    const findMany = vi.fn();
    // #1656: the watcher now discovers WHICH stores had any denial in the
    // window via a groupBy, then pulls each store's own bounded slice —
    // rather than one global `take` that a single noisy store could fill.
    // Defaults to no active stores (empty window); tests that configure rows
    // via `setDenials` below configure this alongside `findMany`.
    const groupBy = vi.fn(async () => [] as { storeId: string | null }[]);
    // The watcher makes a SECOND cross-tenant read: which of the stores in this
    // window have ever completed an agent order. That flag is what separates a
    // broken pre-existing integration from crawler noise, so the stub has to
    // answer it — defaulting to "no prior agent activity", which is what every
    // pre-existing case in this file assumes.
    const orderFindMany = vi.fn(async () => []);
    return {
      mockAuditFindMany: findMany,
      mockAuditGroupBy: groupBy,
      // one store's count of denials in the window: the argument is what the watcher asked for
      mockAuditCount: vi.fn(),
      mockOrderFindMany: orderFindMany,
      mockSendAlert: vi.fn(),
    };
  });

// The watcher reads every store (Postgres and Durable Object alike) through `acrossAllStoresDb` and names them through
// `allStoresDirectory` (Ruling CF-JOBS-4). The stand-in visits the stores the `groupBy` stub names (or the given `storeIds`) and
// hands each the read client the watcher asked for, so the queries it builds stay observable without a database.
const counts = vi.hoisted(() => new Map<string, number>());
vi.mock('@api/lib/jobs/store-db', () => {
  const dbFor = () => ({
    auditLog: {
      count: async (args: { where: { storeId: string } }) => {
        mockAuditCount(args);
        return counts.get(args.where.storeId) ?? 0;
      },
      findMany: (...a: unknown[]) => mockAuditFindMany(...a),
    },
    order: {
      findFirst: async (args: { where: { storeId: string } }) => {
        const rows = (await mockOrderFindMany({ where: { source: 'agent' } })) as Array<{
          storeId: string;
        }>;
        return rows.some(r => r.storeId === args.where.storeId)
          ? { storeId: args.where.storeId }
          : null;
      },
    },
  });
  return {
    allStoresDirectory: async () =>
      [...counts.keys()].map(id => ({ id, name: 'Acme', slug: 'acme' })),
    acrossAllStoresDb: async (
      _event: unknown,
      fn: (storeId: string, db: unknown) => Promise<unknown>,
      o?: { storeIds?: string[] }
    ) => {
      const ids = o?.storeIds ?? [...counts.keys()];
      const out: Array<{ storeId: string; value: unknown }> = [];
      for (const id of ids) out.push({ storeId: id, value: await fn(id, dbFor()) });
      return out;
    },
  };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleAgentWriteDeniedWatch } from '@api/lib/inngest/functions/agent-write-denied-watch';
import { DENIAL_THRESHOLDS, DENIAL_WINDOW_MINUTES } from '@api/mcp/agent-denial-alerts';

function deniedRow(credential: string, ip: string) {
  return {
    storeId: 'store-1',
    ipAddress: ip,
    details: { credential, tool: 'place_order', source: 'agent' },
    store: { name: 'Acme', slug: 'acme' },
  };
}

/**
 * Configure BOTH reads the watcher now makes: the groupBy that discovers
 * which stores are active in the window, and the per-store `findMany` slice.
 * `findMany` returns only the rows of the store it is asked for (see below).
 */
function setDenials(rows: ReturnType<typeof deniedRow>[]) {
  // Honour the per-store `where.storeId` the watcher sends (issue 2055: the
  // old stub returned EVERY row for every store, so no test could observe the
  // fan-out). A query with no storeId still gets everything, so the
  // per-store-scoping mutation stays observable.
  mockAuditFindMany.mockImplementation(async (args?: { where?: { storeId?: string } }) =>
    args?.where?.storeId ? rows.filter(r => r.storeId === args.where!.storeId) : rows
  );
  counts.clear();
  for (const r of rows) if (r.storeId) counts.set(r.storeId, (counts.get(r.storeId) ?? 0) + 1);
  mockAuditGroupBy.mockResolvedValue(
    [...counts].map(([storeId, n]) => ({ storeId, _count: { _all: n } }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setDenials([]);
  mockOrderFindMany.mockReset();
  mockOrderFindMany.mockResolvedValue([]);
  mockSendAlert.mockResolvedValue(undefined);
});

describe('agent-write-denied-watch — what it reads', () => {
  it('discovers active stores via a groupBy scoped to the same action + window', async () => {
    await handleAgentWriteDeniedWatch();

    // audit_logs is RLS-protected: the discovery runs per store, through acrossStores.
    setDenials([deniedRow('none', '1.1.1.1')]);
    await handleAgentWriteDeniedWatch();
    const args = mockAuditCount.mock.calls[0][0];
    expect(args.where.action).toBe('agent.write.denied');

    const since = args.where.createdAt.gte as Date;
    expect(since).toBeInstanceOf(Date);
    const windowMs = Date.now() - since.getTime();
    // Allow a second of execution slack around the declared window.
    expect(windowMs).toBeGreaterThan((DENIAL_WINDOW_MINUTES - 1) * 60_000);
    expect(windowMs).toBeLessThan((DENIAL_WINDOW_MINUTES + 1) * 60_000);
  });

  it('reads ONLY agent.write.denied rows for an active store, within the declared window, in that store scope', async () => {
    setDenials([deniedRow('none', '1.1.1.1')]);

    await handleAgentWriteDeniedWatch();

    const args = mockAuditFindMany.mock.calls[0][0];
    expect(args.where.action).toBe('agent.write.denied');
    expect(args.where.storeId).toBe('store-1');

    const since = args.where.createdAt.gte as Date;
    expect(since).toBeInstanceOf(Date);
    const windowMs = Date.now() - since.getTime();
    expect(windowMs).toBeGreaterThan((DENIAL_WINDOW_MINUTES - 1) * 60_000);
    expect(windowMs).toBeLessThan((DENIAL_WINDOW_MINUTES + 1) * 60_000);
  });

  it('never calls the per-store findMany when no store had any activity in the window', async () => {
    await handleAgentWriteDeniedWatch();
    expect(mockAuditFindMany).not.toHaveBeenCalled();
  });
});

describe('agent-write-denied-watch — silence below threshold', () => {
  it('sends no alert on an empty window', async () => {
    const result = await handleAgentWriteDeniedWatch();
    expect(result).toEqual({ ok: true, denials: 0, findings: 0 });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('sends no alert one refusal below the integration threshold', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.integrationBroken - 1 }, () =>
        deniedRow('invalid', '1.1.1.1')
      )
    );
    const result = await handleAgentWriteDeniedWatch();
    expect(result.findings).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('sends no alert for a pile of credential-less attempts below the volume floor', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.anonymousFlood - 1 }, (_, i) =>
        deniedRow('none', `2.2.2.${i % 5}`)
      )
    );
    expect(mockSendAlert).not.toHaveBeenCalled();
    await handleAgentWriteDeniedWatch();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe('agent-write-denied-watch — dispatch at threshold', () => {
  it('sends a store-scoped p1 naming the store when an integration breaks', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.integrationBroken }, () =>
        deniedRow('invalid', '1.1.1.1')
      )
    );

    const result = await handleAgentWriteDeniedWatch();

    expect(result.findings).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const alert = mockSendAlert.mock.calls[0][0];
    expect(alert.level).toBe('p1');
    expect(alert.scope).toBe('store');
    expect(alert.store).toEqual({ id: 'store-1', name: 'Acme', slug: 'acme' });
    expect(alert.source).toBe('mcp.agent-write-denied.integration_broken');
    expect(alert.context.count).toBe(DENIAL_THRESHOLDS.integrationBroken);
  });

  it('keeps the alert title free of counts so sendAlert can de-duplicate a flap', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.integrationBroken + 7 }, () =>
        deniedRow('invalid', '1.1.1.1')
      )
    );
    await handleAgentWriteDeniedWatch();
    const title = mockSendAlert.mock.calls[0][0].title as string;
    // sendAlert throttles on sha1(level + title + source); a count in the title
    // makes every tick a "new" alert and defeats the throttle entirely.
    expect(title).not.toMatch(/\d/);
  });

  it('escalates a lookup failure to a platform p0 rather than blaming the caller', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.platformFault }, () => deniedRow('error', '1.1.1.1'))
    );
    await handleAgentWriteDeniedWatch();
    const alert = mockSendAlert.mock.calls[0][0];
    expect(alert.level).toBe('p0');
    expect(alert.scope).toBe('platform');
    expect(alert.body).toContain('ENCRYPTION_KEY');
    // Issue 2061: the p0 names the store and, with only ONE affected, points
    // at that store's own key rather than a global env var that is fine.
    expect(alert.body).toContain('"Acme" (store-1)');
    expect(alert.body).toContain('/stores/store-1/agent-key');
    expect(alert.context.storeIds).toEqual(['store-1']);
  });

  it('pages when a store with prior agent orders is refused for having no key', async () => {
    // The wiring test for the rollout's own failure mode. The classifier can
    // only reach `integration_never_credentialed` if the watcher actually
    // performs the prior-agent lookup and threads the flag through — a
    // classifier arm nobody feeds is the same defect as no arm at all.
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.integrationNeverCredentialed }, () =>
        deniedRow('none', '1.1.1.1')
      )
    );
    mockOrderFindMany.mockResolvedValue([{ storeId: 'store-1' }]);

    const result = await handleAgentWriteDeniedWatch();

    expect(result.findings).toBe(1);
    const alert = mockSendAlert.mock.calls[0][0];
    expect(alert.level).toBe('p1');
    expect(alert.source).toBe('mcp.agent-write-denied.integration_never_credentialed');
    // The lookup must be scoped to the stores in this window, not the table.
    expect(mockOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'agent' }) })
    );
  });

  it('stays quiet on the same rows when the store has no agent history', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.integrationNeverCredentialed }, () =>
        deniedRow('none', '1.1.1.1')
      )
    );
    mockOrderFindMany.mockResolvedValue([]);

    const result = await handleAgentWriteDeniedWatch();

    expect(result.findings).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('separates probing from a broken integration on the IP spread alone', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.credentialProbing }, (_, i) =>
        deniedRow('invalid', `9.9.9.${i}`)
      )
    );
    await handleAgentWriteDeniedWatch();
    expect(mockSendAlert.mock.calls[0][0].source).toBe('mcp.agent-write-denied.credential_probing');
  });
});

describe('agent-write-denied-watch — reads the coalesced count (#1644 / #1649)', () => {
  /**
   * `auditAgentWrite` coalesces repeat denials from the same store/ip/tool
   * within a 60s window onto one row carrying `details.count`. If the watcher
   * fed the classifier one-row-per-attempt regardless, a real flood arriving
   * as a handful of coalesced rows would never cross a volume threshold — the
   * exact failure the reverted, count-less first attempt at this fix caused.
   */
  it('a SINGLE coalesced row with details.count at the flood floor still fires', async () => {
    setDenials([
      {
        storeId: 'store-1',
        ipAddress: '2.2.2.2',
        details: {
          credential: 'none',
          tool: 'add_to_cart',
          source: 'agent',
          count: DENIAL_THRESHOLDS.anonymousFlood,
        },
        store: { name: 'Acme', slug: 'acme' },
      },
    ]);

    const result = await handleAgentWriteDeniedWatch();

    expect(result.findings).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    const alert = mockSendAlert.mock.calls[0][0];
    expect(alert.source).toBe('mcp.agent-write-denied.anonymous_flood');
    expect(alert.context.count).toBe(DENIAL_THRESHOLDS.anonymousFlood);
  });

  it('a row missing `details.count` still weighs exactly 1 (pre-existing rows are unaffected)', async () => {
    setDenials(
      Array.from({ length: DENIAL_THRESHOLDS.anonymousFlood - 1 }, (_, i) =>
        deniedRow('none', `2.2.2.${i % 5}`)
      )
    );
    const result = await handleAgentWriteDeniedWatch();
    expect(result.findings).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });
});

describe('agent-write-denied-watch — bounded fan-out (issue 2055, issue 2060)', () => {
  function storeRows(n: number, perStore: (i: number) => number) {
    const rows: ReturnType<typeof deniedRow>[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < perStore(i); k++) {
        rows.push({ ...deniedRow('invalid', `10.0.${i % 250}.1`), storeId: `store-${i}` });
      }
    }
    return rows;
  }

  it('reads at most 100 stores, the noisiest first, in batches of short transactions', async () => {
    // 150 active stores; store-149 is the noisiest and must be read.
    setDenials(storeRows(150, i => (i === 149 ? 5 : 1)));
    await handleAgentWriteDeniedWatch();

    const perStoreReads = mockAuditFindMany.mock.calls.map(
      c => (c[0] as { where: { storeId: string } }).where.storeId
    );
    expect(perStoreReads).toHaveLength(100);
    expect(perStoreReads).toContain('store-149');
    // One short read per store — never one spanning the whole fan-out.
    expect(mockAuditFindMany).toHaveBeenCalledTimes(100);
  });

  it('marks the tick truncated when whole stores were dropped', async () => {
    setDenials(storeRows(150, () => 4));
    await handleAgentWriteDeniedWatch();
    const contexts = mockSendAlert.mock.calls.map(
      c => (c[0] as { context: { truncated: boolean; droppedStores: number } }).context
    );
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every(c => c.truncated === true && c.droppedStores === 50)).toBe(true);
  });
});
