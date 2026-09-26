/**
 * Turning `agent.write.denied` audit rows into alerts — the decision half.
 *
 * The parent change (Ruling M1) made every refused MCP write leave a row.
 * Rows are not detection: nothing read them, so "a merchant's agent lost its
 * key" and "someone is walking the write surface" both looked exactly like
 * silence until the next audit. This module is the pure decision function that
 * closes that; `lib/inngest/functions/agent-write-denied-watch.ts` is the cron
 * that feeds it and dispatches what it returns.
 *
 * ## Why a classifier and not "alert when count > 0"
 *
 * The failure mode that matters for an alert is not missing an incident — it
 * is FIRING SO OFTEN THAT SOMEONE MUTES IT. A store that publishes MCP tools in
 * its `llms.txt` will be found by crawlers and generic agents that never had a
 * credential and never will; those callers send NO `x-agent-key` header at all
 * and get refused, forever, as designed. A count-based alert on the raw denial
 * rate would page on that background every 15 minutes from day one, be muted
 * inside a week, and then be missing when a paying merchant's integration
 * actually broke. So the rate alone is never the signal. WHAT THE CALLER
 * PRESENTED is.
 *
 * `resolveAgentAuth` already records that, per attempt, in the audit row's
 * `details.credential` (`AgentCredentialOutcome`), and it is exactly the
 * discriminator:
 *
 *   - `none`          — no header. The expected background. A caller that
 *                       never had a key is not a broken integration and not,
 *                       on its own, an attack. Only a genuine VOLUME anomaly
 *                       is worth an `info`-level line.
 *   - `invalid` /     — a credential WAS presented and did not match. Someone
 *     `unconfigured`    believes they hold this store's key. That is either the
 *                       merchant's own automation still sending a key that was
 *                       rotated or revoked out from under it (integration
 *                       broken — their agent checkout is DOWN right now), or
 *                       someone guessing (probing). Both are worth waking up
 *                       for; they are separated below.
 *   - `error`         — OUR fault, not theirs: the credential lookup or the
 *                       AES decrypt threw and the resolver degraded to
 *                       "denied" (deliberately — a DB blip must not kill the
 *                       anonymous read surface). A wrong/rotated
 *                       `ENCRYPTION_KEY` therefore refuses EVERY agent write on
 *                       EVERY store while looking, in the rows, identical to a
 *                       merchant sending a bad key. Nothing else in the system
 *                       would say so.
 *
 * ## Broken integration vs probing
 *
 * Both present a credential, so the count cannot separate them. The DISTINCT
 * SOURCE IP COUNT can: a merchant's agent runs from a small, stable egress set
 * — one or two addresses — and repeats the same wrong key. A probe sweeps from
 * many addresses, or hits many stores. So:
 *
 *   ≤ PROBE_DISTINCT_IPS-1 distinct IPs  → `integration_broken` (p1, store)
 *   ≥ PROBE_DISTINCT_IPS   distinct IPs  → `credential_probing` (p1, store)
 *
 * and when a single window has probing against
 * `CROSS_STORE_PROBE_STORES`+ different stores, the per-store alerts are
 * REPLACED by one platform p0 — a coordinated sweep is one incident, and
 * emitting forty store-scoped alerts for it is the same "mute me" failure by a
 * different route.
 *
 * The thresholds are deliberately asymmetric: `integration_broken` fires at 3
 * because it is rare (it takes a merchant who HAD a key) and it means a paying
 * customer's automation is down; `credential_probing` fires at 10 because a
 * refused write is already the gate working, so it is intelligence rather than
 * an outage.
 *
 * Levels follow `alerts.service`'s meaning — p0 = wake someone now. Only the
 * two classes that are OURS to fix at 3am are p0: the platform fault, and a
 * cross-store sweep. A single store's broken integration and a single store's
 * probing are p1: real, actionable in the morning, not an outage of the
 * platform.
 *
 * `agent.write.failed` (an AUTHORISED write that then threw) is deliberately
 * out of scope here — a different class with a different owner, already
 * reaching Sentry through the tool handler. Named so it is a decision, not an
 * omission.
 */

import type { AgentCredentialOutcome } from './agent-auth';

/** How far back a single watcher tick looks. */
export const DENIAL_WINDOW_MINUTES = 16;

/** ≥ this many distinct source IPs in one window reads as a sweep, not one agent. */
export const PROBE_DISTINCT_IPS = 3;

/** Per-store, per-window firing thresholds. */
export const DENIAL_THRESHOLDS = {
  /** Our own decrypt/DB failure silently refusing legitimate agents. */
  platformFault: 3,
  /** A credential is being presented and no longer matches, from a stable source. */
  integrationBroken: 3,
  /** A credential is being presented and no longer matches, from many sources. */
  credentialProbing: 10,
  /** Callers that never present a header at all — expected background, volume-only. */
  anonymousFlood: 50,
  /**
   * A store that HAS transacted by agent before is now being refused with no
   * header at all. Same threshold as `integrationBroken`, because it is the
   * same event seen from the other side: an integration that worked yesterday
   * has stopped, it just predates the credential so it has nothing to present.
   */
  integrationNeverCredentialed: 3,
} as const;

/** Distinct stores probed in one window before it is treated as one platform event. */
export const CROSS_STORE_PROBE_STORES = 3;

/** One `agent.write.denied` audit row, reduced to what the decision needs. */
export interface AgentDenialRow {
  storeId: string;
  storeName?: string | null;
  storeSlug?: string | null;
  /** `details.credential` — see `AgentCredentialOutcome`. */
  credential: AgentCredentialOutcome | string | null | undefined;
  /** `audit_logs.ip_address`. Null is treated as its own distinct source. */
  ipAddress?: string | null;
  /** `details.tool` — reported so the operator knows which write was refused. */
  tool?: string | null;
  /**
   * Has this store EVER completed an agent-sourced write (`Order.source =
   * 'agent'`)? Supplied by the watcher.
   *
   * This — not "the store has no key yet" — is the discriminator. At deploy NO
   * store has a key, so keying on the key's absence would page on every
   * crawler that ever touched `/mcp`. Prior agent volume is what separates
   * "an integration we broke" from "background noise that was never going to
   * succeed".
   */
  storeHadPriorAgentActivity?: boolean;
}

export type AgentDenialClass =
  | 'platform_fault'
  | 'integration_broken'
  | 'credential_probing'
  | 'integration_never_credentialed'
  | 'anonymous_flood';

export interface AgentDenialFinding {
  kind: AgentDenialClass;
  level: 'p0' | 'p1' | 'info';
  scope: 'platform' | 'store';
  /** Absent for the platform-scoped cross-store roll-up. */
  store?: { id: string; name: string; slug?: string };
  /** Rows in this window that produced the finding. */
  count: number;
  distinctIps: number;
  /** Tool names seen, deduped, for the alert body. */
  tools: string[];
  /** Only set on the cross-store roll-up. */
  storesAffected?: number;
}

/** Single bucket for rows with no recorded source address. */
const UNKNOWN_IP = '<unknown>';

/**
 * All rows with no recorded ip collapse to ONE bucket, deliberately.
 *
 * The first version gave each of them a distinct `unknown-${index}`, which is
 * the wrong direction twice over: an absent `ip_address` is a platform or proxy
 * condition affecting every row equally, not evidence of many callers, so
 * counting them as distinct claims knowledge we do not have — and because the
 * spread is what picks the class AND the threshold, a merchant integration
 * whose rows lost their ip would have been relabelled `credential_probing` and
 * had its firing threshold raised from 3 to 10. That is not a cosmetic
 * mislabel: it sends the operator hunting an attacker instead of calling the
 * merchant, and it delays or suppresses the alert for the case the low
 * threshold exists to catch.
 */
function ipKey(ip: string | null | undefined): string {
  return ip && ip.length > 0 ? ip : UNKNOWN_IP;
}

function toolsOf(rows: AgentDenialRow[]): string[] {
  return [...new Set(rows.map(r => r.tool).filter((t): t is string => Boolean(t)))].sort();
}

function countDistinctIps(rows: AgentDenialRow[]): number {
  return new Set(rows.map(r => ipKey(r.ipAddress))).size;
}

/**
 * Decide what (if anything) to alert on for one window's denial rows.
 *
 * TOTAL and pure: no clock, no I/O, no throwing. An empty input returns an
 * empty array — which is the answer that must hold on almost every tick, and
 * the direction an alert test most often forgets to assert.
 */
export function classifyAgentDenials(rows: AgentDenialRow[]): AgentDenialFinding[] {
  const byStore = new Map<string, AgentDenialRow[]>();
  for (const row of rows) {
    if (!row || typeof row.storeId !== 'string' || row.storeId.length === 0) continue;
    const bucket = byStore.get(row.storeId);
    if (bucket) bucket.push(row);
    else byStore.set(row.storeId, [row]);
  }

  const findings: AgentDenialFinding[] = [];

  // #1653 (2026-09-25 security audit): `platform_fault` is OUR bug (a wrong
  // or rotated ENCRYPTION_KEY refuses every agent write on EVERY store), so
  // it has to be judged across the whole window, not one store at a time. The
  // per-store version below used to require `platformFault` (3) faults
  // inside a SINGLE store's bucket — a decrypt failure spread thinly across
  // many stores (2 rows each in 5 different stores = 10 total) never reached
  // 3 in any one bucket and the p0 that exists specifically to catch "this is
  // us, not them" never fired. Computed once, over every valid row, before
  // the per-store loop — genuinely platform-scoped, matching the
  // `credential_probing` cross-store roll-up's shape (no `store` field).
  const allRows = [...byStore.values()].flat();
  const allFaults = allRows.filter(r => r.credential === 'error');
  if (allFaults.length >= DENIAL_THRESHOLDS.platformFault) {
    findings.push({
      kind: 'platform_fault',
      level: 'p0',
      scope: 'platform',
      count: allFaults.length,
      distinctIps: countDistinctIps(allFaults),
      tools: toolsOf(allFaults),
      storesAffected: new Set(allFaults.map(r => r.storeId)).size,
    });
  }

  for (const [storeId, storeRows] of byStore) {
    const store = {
      id: storeId,
      name: storeRows.find(r => r.storeName)?.storeName ?? storeId,
      slug: storeRows.find(r => r.storeSlug)?.storeSlug ?? undefined,
    };

    // A credential was PRESENTED and did not authorise the write.
    const presented = storeRows.filter(
      r => r.credential === 'invalid' || r.credential === 'unconfigured'
    );
    if (presented.length > 0) {
      const distinctIps = countDistinctIps(presented);
      const probing = distinctIps >= PROBE_DISTINCT_IPS;
      const threshold = probing
        ? DENIAL_THRESHOLDS.credentialProbing
        : DENIAL_THRESHOLDS.integrationBroken;
      if (presented.length >= threshold) {
        findings.push({
          kind: probing ? 'credential_probing' : 'integration_broken',
          level: 'p1',
          scope: 'store',
          store,
          count: presented.length,
          distinctIps,
          tools: toolsOf(presented),
        });
      }
    }

    // No header at all. Two very different populations share this shape, and
    // the split is the whole point:
    //
    //   - A store that has NEVER transacted by agent: crawlers and scanners
    //     hitting a public endpoint. Expected background, volume anomaly only.
    //   - A store that HAS transacted by agent: an integration that worked
    //     before this credential existed. It cannot present a header it was
    //     never issued, so it will look identical to a crawler forever while
    //     the merchant quietly loses orders.
    //
    // Folding the second into the first is how a rollout breaks someone
    // silently: at 10 refused orders/hour a real merchant never reaches the
    // 50-per-16-minute flood threshold, so nothing fires at all.
    const anonymous = storeRows.filter(r => r.credential === 'none' || r.credential == null);
    const hadPriorAgentActivity = storeRows.some(r => r.storeHadPriorAgentActivity === true);

    if (
      hadPriorAgentActivity &&
      anonymous.length >= DENIAL_THRESHOLDS.integrationNeverCredentialed
    ) {
      findings.push({
        kind: 'integration_never_credentialed',
        level: 'p1',
        scope: 'store',
        store,
        count: anonymous.length,
        distinctIps: countDistinctIps(anonymous),
        tools: toolsOf(anonymous),
      });
    } else if (anonymous.length >= DENIAL_THRESHOLDS.anonymousFlood) {
      findings.push({
        kind: 'anonymous_flood',
        level: 'info',
        scope: 'store',
        store,
        count: anonymous.length,
        distinctIps: countDistinctIps(anonymous),
        tools: toolsOf(anonymous),
      });
    }
  }

  // A sweep across many stores is ONE incident. Collapse the per-store probing
  // findings into a single platform p0 rather than paging once per merchant.
  const probes = findings.filter(f => f.kind === 'credential_probing');
  if (probes.length >= CROSS_STORE_PROBE_STORES) {
    const kept = findings.filter(f => f.kind !== 'credential_probing');
    kept.push({
      kind: 'credential_probing',
      level: 'p0',
      scope: 'platform',
      count: probes.reduce((sum, p) => sum + p.count, 0),
      distinctIps: probes.reduce((max, p) => Math.max(max, p.distinctIps), 0),
      tools: [...new Set(probes.flatMap(p => p.tools))].sort(),
      storesAffected: probes.length,
    });
    return kept;
  }

  return findings;
}
