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

const { mockAuditFindMany, mockOrderFindMany, mockSendAlert, mockRlsBypass } = vi.hoisted(() => {
  const findMany = vi.fn();
  // The watcher makes a SECOND cross-tenant read: which of the stores in this
  // window have ever completed an agent order. That flag is what separates a
  // broken pre-existing integration from crawler noise, so the stub has to
  // answer it — defaulting to "no prior agent activity", which is what every
  // pre-existing case in this file assumes.
  const orderFindMany = vi.fn(async () => []);
  return {
    mockAuditFindMany: findMany,
    mockOrderFindMany: orderFindMany,
    mockSendAlert: vi.fn(),
    mockRlsBypass: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ auditLog: { findMany }, order: { findMany: orderFindMany } })
    ),
  };
});

vi.mock('@force/database', () => ({ withRlsBypass: mockRlsBypass }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditFindMany.mockResolvedValue([]);
  mockOrderFindMany.mockReset();
  mockOrderFindMany.mockResolvedValue([]);
  mockSendAlert.mockResolvedValue(undefined);
});

describe('agent-write-denied-watch — what it reads', () => {
  it('reads ONLY agent.write.denied rows, within the declared window, past RLS', async () => {
    await handleAgentWriteDeniedWatch();

    expect(mockRlsBypass).toHaveBeenCalled(); // audit_logs is RLS-protected
    const args = mockAuditFindMany.mock.calls[0][0];
    expect(args.where.action).toBe('agent.write.denied');

    const since = args.where.createdAt.gte as Date;
    expect(since).toBeInstanceOf(Date);
    const windowMs = Date.now() - since.getTime();
    // Allow a second of execution slack around the declared window.
    expect(windowMs).toBeGreaterThan((DENIAL_WINDOW_MINUTES - 1) * 60_000);
    expect(windowMs).toBeLessThan((DENIAL_WINDOW_MINUTES + 1) * 60_000);
  });
});

describe('agent-write-denied-watch — silence below threshold', () => {
  it('sends no alert on an empty window', async () => {
    const result = await handleAgentWriteDeniedWatch();
    expect(result).toEqual({ ok: true, denials: 0, findings: 0 });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('sends no alert one refusal below the integration threshold', async () => {
    mockAuditFindMany.mockResolvedValue(
      Array.from({ length: DENIAL_THRESHOLDS.integrationBroken - 1 }, () =>
        deniedRow('invalid', '1.1.1.1')
      )
    );
    const result = await handleAgentWriteDeniedWatch();
    expect(result.findings).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('sends no alert for a pile of credential-less attempts below the volume floor', async () => {
    mockAuditFindMany.mockResolvedValue(
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
    mockAuditFindMany.mockResolvedValue(
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
    mockAuditFindMany.mockResolvedValue(
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
    mockAuditFindMany.mockResolvedValue(
      Array.from({ length: DENIAL_THRESHOLDS.platformFault }, () => deniedRow('error', '1.1.1.1'))
    );
    await handleAgentWriteDeniedWatch();
    const alert = mockSendAlert.mock.calls[0][0];
    expect(alert.level).toBe('p0');
    expect(alert.scope).toBe('platform');
    expect(alert.body).toContain('ENCRYPTION_KEY');
  });

  it('pages when a store with prior agent orders is refused for having no key', async () => {
    // The wiring test for the rollout's own failure mode. The classifier can
    // only reach `integration_never_credentialed` if the watcher actually
    // performs the prior-agent lookup and threads the flag through — a
    // classifier arm nobody feeds is the same defect as no arm at all.
    mockAuditFindMany.mockResolvedValue(
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
    mockAuditFindMany.mockResolvedValue(
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
    mockAuditFindMany.mockResolvedValue(
      Array.from({ length: DENIAL_THRESHOLDS.credentialProbing }, (_, i) =>
        deniedRow('invalid', `9.9.9.${i}`)
      )
    );
    await handleAgentWriteDeniedWatch();
    expect(mockSendAlert.mock.calls[0][0].source).toBe('mcp.agent-write-denied.credential_probing');
  });
});
