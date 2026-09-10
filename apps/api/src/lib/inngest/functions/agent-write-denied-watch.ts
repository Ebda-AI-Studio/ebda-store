import type { InngestFunction } from 'inngest';
import { withRlsBypass } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import {
  classifyAgentDenials,
  DENIAL_WINDOW_MINUTES,
  DENIAL_THRESHOLDS,
  PROBE_DISTINCT_IPS,
  CROSS_STORE_PROBE_STORES,
  type AgentDenialFinding,
  type AgentDenialRow,
} from '../../../mcp/agent-denial-alerts';

/**
 * Every-15-min watcher over `agent.write.denied` audit rows.
 *
 * The credential requirement (Ruling M1) refuses unauthorised MCP writes and
 * records each refusal. Until this function existed nothing READ those rows, so
 * a merchant whose agent lost its key and someone walking the write surface
 * were both indistinguishable from a quiet day — the detection half of M1's
 * "detected by the new 401 metric" was open debt, listed as such in the parent
 * PR's report (§8.9).
 *
 * WHAT to alert on — the thresholds, the classes, and why a broken integration
 * must not look like probing — lives in `mcp/agent-denial-alerts.ts` as a pure
 * function. This file is only the plumbing: read the window, hand the rows over,
 * dispatch whatever comes back.
 *
 * Cadence: a 15-minute cron, window `DENIAL_WINDOW_MINUTES` (16). The one minute of
 * deliberate overlap means a row landing on a tick boundary is never dropped by
 * a late scheduler; the cost is that the rare boundary row can be counted twice,
 * which cannot manufacture a finding on its own at these thresholds. Because the
 * window matches the cadence, an ongoing incident re-alerts at most once every
 * 15 minutes per class per store — a noisy alert is one that gets muted, and a
 * muted alert is the failure this whole function exists to avoid.
 *
 * Cross-tenant cron: `audit_logs` is an RLS table and no tenant GUC is set in an
 * Inngest worker, so a plain prisma read returns zero rows and the watcher would
 * report "healthy" forever. `withRlsBypass` is what `queue-depth-watch` uses for
 * the same reason.
 *
 * Adjacent alerting, NOT duplicated here: `alerts-failure-watch` dead-letters
 * Inngest function failures (including this one's, since `retries: 0` means a
 * throw here is immediately final), and Sentry catches exceptions inside the MCP
 * tool handlers. Neither can see a refusal, because a refusal is not an error.
 */

/**
 * Hard cap on rows pulled per tick. 5000 refusals in 16 minutes is already far
 * past every threshold, so truncation cannot change WHETHER an alert fires —
 * only the count printed in it, which is reported as a floor when the cap is hit.
 */
const MAX_ROWS = 5000;

function bodyFor(finding: AgentDenialFinding, truncated: boolean): string {
  const countPhrase = truncated ? `at least ${finding.count}` : `${finding.count}`;
  const tools = finding.tools.length > 0 ? finding.tools.join(', ') : 'unknown';
  const window = `${DENIAL_WINDOW_MINUTES} min`;

  switch (finding.kind) {
    case 'platform_fault':
      return (
        `${countPhrase} agent write(s) on "${finding.store?.name}" were refused in the last ${window} ` +
        `because the credential lookup itself FAILED (details.credential="error") — a DB error or an ` +
        `AES decrypt error, not a caller mistake. This store's agent checkout is down and the rows blame ` +
        `the caller. Check ENCRYPTION_KEY on the API and the Store.agent_api_key ciphertext. If the ` +
        `key itself is wrong every store is affected, and sendAlert's throttle collapses them into ` +
        `this one message — the store named above is an example, not the blast radius. Tools: ${tools}.`
      );
    case 'integration_broken':
      return (
        `${countPhrase} agent write(s) on "${finding.store?.name}" were refused in the last ${window}. ` +
        `A credential WAS presented and did not match, from ${finding.distinctIps} source IP(s) — ` +
        `below the ${PROBE_DISTINCT_IPS}-IP spread that reads as probing, so this is most likely the ` +
        `merchant's own integration still sending a key that was rotated or revoked. Their agent ` +
        `checkout is failing right now. Fix: re-issue at /stores/<id>/agent-key and hand the merchant ` +
        `the new key. Tools: ${tools}.`
      );
    case 'credential_probing':
      return finding.scope === 'platform'
        ? `${countPhrase} agent write(s) across ${finding.storesAffected} stores were refused in the last ` +
            `${window}, each presenting a credential that did not match, from up to ${finding.distinctIps} ` +
            `source IPs per store. A ${CROSS_STORE_PROBE_STORES}+-store spread is a sweep of the MCP write ` +
            `surface, not one broken merchant integration. The gate held — every write was refused — so ` +
            `this is intelligence, not an outage. Tools: ${tools}.`
        : `${countPhrase} agent write(s) on "${finding.store?.name}" were refused in the last ${window}, ` +
            `each presenting a credential that did not match, from ${finding.distinctIps} distinct source ` +
            `IPs. That spread is a sweep rather than one misconfigured agent. The gate held — every write ` +
            `was refused. Tools: ${tools}.`;
    case 'integration_never_credentialed':
      return (
        `${countPhrase} agent write(s) on "${finding.store?.name}" were refused in the last ${window} ` +
        `with NO credential presented — and this store has completed agent orders before. That is an ` +
        `integration which predates the credential requirement: it cannot send a key it was never ` +
        `issued, so it will keep failing silently and the merchant loses those orders. Either issue a ` +
        `key at /stores/${finding.store?.id}/agent-key and get it to them, or set the ` +
        `\`agent_checkout_open_writes\` feature override on this store to restore the previous ` +
        `behaviour while that happens. Sources: ${finding.distinctIps} IP(s). Tools: ${tools}.`
      );
    case 'anonymous_flood':
      return (
        `${countPhrase} agent write(s) on "${finding.store?.name}" were refused in the last ${window} ` +
        `from callers presenting NO x-agent-key at all, over the ${DENIAL_THRESHOLDS.anonymousFlood} ` +
        `volume floor. Unauthenticated agents finding the tools through llms.txt is EXPECTED and this is ` +
        `informational — it is flagged only because the volume is abnormal. Tools: ${tools}.`
      );
  }
}

function titleFor(finding: AgentDenialFinding): string {
  // Deliberately stable — no counts. `sendAlert` de-duplicates on
  // sha1(level + title + source), so a title carrying a number would defeat
  // its throttle on exactly the flapping case the throttle is for.
  switch (finding.kind) {
    case 'platform_fault':
      return 'agent write credential lookup is FAILING (platform fault, not the caller)';
    case 'integration_broken':
      return 'agent write denied repeatedly — a merchant integration is presenting a stale key';
    case 'credential_probing':
      return finding.scope === 'platform'
        ? 'agent write credential probing across multiple stores'
        : 'agent write credential probing on one store';
    case 'integration_never_credentialed':
      return 'a store that used to transact by agent is now being refused — it has no key';
    case 'anonymous_flood':
      return 'unusual volume of credential-less agent write attempts';
  }
}

/**
 * The tick body, exported so it can be unit-tested directly.
 *
 * `inngest.createFunction` is stubbed out in unit tests (its wrapper is built at
 * module load), so a handler defined inline inside it is unreachable — a
 * classifier nobody calls is the same defect as no classifier at all, and only
 * a test that runs THIS proves the wiring.
 */
export async function handleAgentWriteDeniedWatch(): Promise<{
  ok: true;
  denials: number;
  findings: number;
}> {
  const since = new Date(Date.now() - DENIAL_WINDOW_MINUTES * 60 * 1000);

  const rows = await withRlsBypass(tx =>
    tx.auditLog.findMany({
      where: { action: 'agent.write.denied', createdAt: { gte: since } },
      select: {
        storeId: true,
        ipAddress: true,
        details: true,
        store: { select: { name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    })
  );

  const truncated = rows.length >= MAX_ROWS;

  const denials: AgentDenialRow[] = rows
    .filter((r): r is typeof r & { storeId: string } => typeof r.storeId === 'string')
    .map(r => {
      const details = (r.details ?? {}) as Record<string, unknown>;
      return {
        storeId: r.storeId,
        storeName: r.store?.name ?? null,
        storeSlug: r.store?.slug ?? null,
        credential: typeof details.credential === 'string' ? details.credential : null,
        ipAddress: r.ipAddress,
        tool: typeof details.tool === 'string' ? details.tool : null,
      };
    });

  // Which of the stores in this window have EVER completed an agent-sourced
  // order. Bounded by the stores actually present in the window, not the whole
  // table, so this stays one small indexed query per tick. `withRlsBypass` for
  // the same reason the read above needs it: this cron is cross-tenant.
  const storeIdsInWindow = [...new Set(denials.map(d => d.storeId))];
  const priorAgentStores = new Set<string>();
  if (storeIdsInWindow.length > 0) {
    const prior = await withRlsBypass(tx =>
      tx.order.findMany({
        where: { source: 'agent', storeId: { in: storeIdsInWindow } },
        select: { storeId: true },
        distinct: ['storeId'],
      })
    );
    for (const row of prior) {
      if (row.storeId) priorAgentStores.add(row.storeId);
    }
  }

  const findings = classifyAgentDenials(
    denials.map(d => ({ ...d, storeHadPriorAgentActivity: priorAgentStores.has(d.storeId) }))
  );

  if (findings.length === 0) {
    // The answer on almost every tick. Quiet on purpose — a line here, not an
    // alert, so the trend stays visible in the logs without paging anyone.
    logger.info(
      { denials: denials.length, windowMinutes: DENIAL_WINDOW_MINUTES },
      'agent-write-denied-watch: no denial pattern over threshold'
    );
    return { ok: true, denials: denials.length, findings: 0 };
  }

  for (const finding of findings) {
    await sendAlert({
      level: finding.level,
      scope: finding.scope,
      store:
        finding.scope === 'store' && finding.store
          ? { id: finding.store.id, name: finding.store.name, slug: finding.store.slug }
          : undefined,
      source: `mcp.agent-write-denied.${finding.kind}`,
      title: titleFor(finding),
      body: bodyFor(finding, truncated),
      context: {
        kind: finding.kind,
        count: finding.count,
        distinctIps: finding.distinctIps,
        tools: finding.tools,
        storeId: finding.store?.id,
        storesAffected: finding.storesAffected,
        windowMinutes: DENIAL_WINDOW_MINUTES,
        truncated,
      },
    });
  }

  logger.warn(
    {
      denials: denials.length,
      findings: findings.map(f => ({ kind: f.kind, level: f.level, count: f.count })),
      truncated,
    },
    'agent-write-denied-watch: denial pattern detected, alerts dispatched'
  );

  return { ok: true, denials: denials.length, findings: findings.length };
}

const agentWriteDeniedWatchFn = inngest.createFunction(
  {
    id: 'agent-write-denied-watch',
    name: 'Agent-write denial watcher (agent.write.denied → Telegram)',
    retries: 0, // failing to alert is recoverable; the next tick fires in 15 min
    triggers: [{ cron: '*/15 * * * *' }],
  },
  handleAgentWriteDeniedWatch
);

export const agentWriteDeniedWatch: InngestFunction.Any = agentWriteDeniedWatchFn;
