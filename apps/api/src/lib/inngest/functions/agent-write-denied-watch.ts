import type { JobDef } from '../../jobs/types';
import { acrossAllStoresDb, allStoresDirectory } from '../../jobs/store-db';
import type { JobEvent } from '../../jobs/types';
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
 * Hourly watcher over `agent.write.denied` audit rows.
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
 * Cadence: an HOURLY cron (Ruling INNGEST-BUDGET-1), window `DENIAL_WINDOW_MINUTES` (61). The one minute of
 * deliberate overlap means a row landing on a tick boundary is never dropped by
 * a late scheduler; the cost is that the rare boundary row can be counted twice,
 * which cannot manufacture a finding on its own at these thresholds. Because the
 * window matches the cadence, an ongoing incident re-alerts at most once every
 * hour per class per store — a noisy alert is one that gets muted, and a
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
 * Hard cap on rows pulled per STORE per tick (#1656, 2026-09-25 security
 * audit).
 *
 * This used to be one GLOBAL `orderBy: desc, take: 5000` across every store.
 * `add_to_cart`/`place_order` denials are reachable by a fully unauthenticated
 * caller (bounded only by `publicLimiter`'s 300/min/IP), so a single noisy
 * store could fill the entire 5000-row cap with its own rows — at which
 * point every OTHER store's denials in the window are simply absent from
 * `denials`, and `classifyAgentDenials` never sees them: a quiet store
 * looks identical to a store whose alert visibility was starved by someone
 * else's flood. Querying each store's own bounded, newest-first slice (see
 * `handleAgentWriteDeniedWatch` below) means one store's volume can no
 * longer suppress another's. 1000/store in a 16-minute window is already
 * ~20x every classification threshold (the highest, `anonymousFlood`, is 50).
 */
const MAX_ROWS_PER_STORE = 1000;

/**
 * Bound on the per-store fan-out (issue 2055 / issue 2060). The store set comes
 * straight from a groupBy over every store with a denial in the window, and a
 * cross-store credential sweep — the incident this watcher exists to page on —
 * makes EVERY store active. Uncapped, N per-store reads shared one 30s
 * `withRlsBypass` transaction (one connection, so wall-clock is the SUM), and
 * with `retries: 0` a tick that overran produced no alert at all. Now: only
 * the noisiest MAX_STORES_PER_TICK stores are read (the drop is logged and
 * marks the tick `truncated`), in batches of STORE_READ_BATCH, each batch in
 * its own short transaction. 100 stores is far past the 3-store threshold
 * that makes a sweep a platform alert.
 */
const MAX_STORES_PER_TICK = 100;
const STORE_READ_BATCH = 10;

function bodyFor(finding: AgentDenialFinding, truncated: boolean): string {
  const countPhrase = truncated ? `at least ${finding.count}` : `${finding.count}`;
  const tools = finding.tools.length > 0 ? finding.tools.join(', ') : 'unknown';
  const window = `${DENIAL_WINDOW_MINUTES} min`;

  switch (finding.kind) {
    case 'platform_fault': {
      // #1653: computed across EVERY store (a fault spread thinly no longer
      // hides below any one store's threshold), so the finding is
      // platform-scoped — but it still NAMES the stores (issue 2061). One
      // affected store points at that store's own ciphertext, not at a global
      // env var that is fine; several point at ENCRYPTION_KEY.
      const named = (finding.stores ?? []).map(s => `"${s.name}" (${s.id})`);
      const more =
        (finding.storesAffected ?? 0) > named.length
          ? ` and ${(finding.storesAffected ?? 0) - named.length} more`
          : '';
      const where = named.length > 0 ? ` Store(s): ${named.join(', ')}${more}.` : '';
      const fix =
        finding.storesAffected === 1 && finding.stores?.[0]
          ? `Only ONE store is affected, so this is most likely that store's Store.agent_api_key ` +
            `ciphertext (a partial key rotation), not the platform ENCRYPTION_KEY — re-issue its key at ` +
            `/stores/${finding.stores[0].id}/agent-key.`
          : `Check ENCRYPTION_KEY on the API, then the Store.agent_api_key ciphertext of the stores named.`;
      return (
        `${countPhrase} agent write(s) across ${finding.storesAffected ?? 'multiple'} store(s) were ` +
        `refused in the last ${window} because the credential lookup itself FAILED ` +
        `(details.credential="error") — a DB error or an AES decrypt error, not a caller mistake. ` +
        `Agent checkout is failing and the rows blame the caller.${where} ${fix} Tools: ${tools}.`
      );
    }
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
export async function handleAgentWriteDeniedWatch(event?: Pick<JobEvent, 'data'>): Promise<{
  ok: true;
  denials: number;
  findings: number;
}> {
  const since = new Date(Date.now() - DENIAL_WINDOW_MINUTES * 60 * 1000);

  // Which stores had ANY denial in the window — cheap, indexed aggregate, not
  // the rows themselves. See MAX_ROWS_PER_STORE above for why this replaced a
  // single global `take`.
  // Per store (each in its own tenant scope): `audit_logs` is store-scoped.
  // Every store, Postgres and Durable Object alike, from this one run (Ruling CF-JOBS-4): the watcher ranks stores against each
  // other and classifies patterns ACROSS them, so it cannot be split into per-store alarms. A DO store is read through its DO.
  const activeStores = (
    await acrossAllStoresDb(event, (storeId, db) =>
      db.auditLog.count({
        where: { action: 'agent.write.denied', createdAt: { gte: since }, storeId },
      })
    )
  )
    .filter(r => r.value > 0)
    .map(r => ({ storeId: r.storeId, _count: { _all: r.value } }));
  const ranked = activeStores.sort((a, b) => b._count._all - a._count._all);
  const storeIds = ranked.slice(0, MAX_STORES_PER_TICK).map(g => g.storeId);
  const droppedStores = ranked.length - storeIds.length;
  if (droppedStores > 0) {
    logger.warn(
      { activeStores: ranked.length, read: storeIds.length, droppedStores },
      'agent-write-denied-watch: store fan-out capped — quietest stores not read this tick'
    );
  }

  const names = new Map(
    (await allStoresDirectory(event)).map(s => [s.id, { name: s.name, slug: s.slug }] as const)
  );
  const rowsByStore: Array<
    Array<{
      storeId: string | null;
      ipAddress: string | null;
      details: unknown;
      store: { name: string; slug: string } | null;
    }>
  > = [];
  for (let i = 0; i < storeIds.length; i += STORE_READ_BATCH) {
    const batch = storeIds.slice(i, i + STORE_READ_BATCH);
    const slices = await Promise.all(
      batch.map(async storeId => {
        const [rows] = (
          await acrossAllStoresDb(
            event,
            (_id, db) =>
              db.auditLog.findMany({
                where: { action: 'agent.write.denied', createdAt: { gte: since }, storeId },
                select: { storeId: true, ipAddress: true, details: true },
                orderBy: { createdAt: 'desc' },
                take: MAX_ROWS_PER_STORE,
              }),
            { storeIds: [storeId] }
          )
        ).map(r => r.value);
        // the store's name and slug come from the platform directory (the DO has no `stores` row to join)
        const meta = names.get(storeId) ?? null;
        return (rows ?? []).map(r => ({ ...r, store: meta }));
      })
    );
    rowsByStore.push(...slices);
  }

  const rows = rowsByStore.flat();
  // Coarse on purpose (matches the prior single-flag behaviour downstream):
  // true when ANY one store's own slice hit its cap, or when whole stores were
  // dropped by the fan-out cap, so a caller sees "at least N" rather than a
  // false exact count.
  const truncated =
    droppedStores > 0 || rowsByStore.some(storeRows => storeRows.length >= MAX_ROWS_PER_STORE);

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
        // `auditAgentWrite` coalesces repeat denials from the same
        // store/ip/tool/credential within a 60s window onto one row carrying
        // `details.count` (#1644 / #1649) — absent/invalid means this row was
        // never coalesced, i.e. it stands for exactly one attempt.
        count:
          typeof details.count === 'number' && Number.isFinite(details.count) && details.count > 0
            ? details.count
            : 1,
      };
    });

  // Which of the stores in this window have EVER completed an agent-sourced
  // order. Bounded by the stores actually present in the window, not the whole
  // table, so this stays one small indexed query per tick. Read per store for
  // the same reason as above: this cron is cross-tenant.
  const storeIdsInWindow = [...new Set(denials.map(d => d.storeId))];
  const priorAgentStores = new Set<string>();
  if (storeIdsInWindow.length > 0) {
    const prior = await acrossAllStoresDb(
      event,
      (storeId, db) =>
        db.order.findFirst({ where: { source: 'agent', storeId }, select: { storeId: true } }),
      { storeIds: storeIdsInWindow }
    );
    for (const row of prior) {
      if (row.value?.storeId) priorAgentStores.add(row.value.storeId);
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
        storeIds: finding.stores?.map(s => s.id),
        windowMinutes: DENIAL_WINDOW_MINUTES,
        truncated,
        droppedStores,
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
    retries: 0, // failing to alert is recoverable; the next tick fires in an hour
    // HOURLY (Ruling INNGEST-BUDGET-1); DENIAL_WINDOW_MINUTES is cadence + 1 min and moves with it.
    triggers: [{ cron: '7 * * * *' }],
  },
  async ({ event }) => handleAgentWriteDeniedWatch(event)
);

export const agentWriteDeniedWatch: JobDef = agentWriteDeniedWatchFn;
