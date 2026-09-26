/**
 * The `agent.write.denied` alert decision — BOTH directions.
 *
 * A one-directional alert test ("it fires when I feed it a flood") is how an
 * alert that never fires in production gets shipped: the interesting half is
 * everything just BELOW the threshold, where the answer must be silence. Every
 * class here is asserted at `threshold - 1` (silent) and at `threshold` (fires),
 * so the boundary itself is pinned rather than the general shape.
 *
 * The second property under test is the one the classifier exists for: a
 * merchant's own broken integration and someone probing the write surface both
 * produce denials that presented a credential, so they are separated by the
 * DISTINCT SOURCE IP spread, not by the count. A test that only fed one IP
 * would never notice that half of the logic disappearing.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAgentDenials,
  DENIAL_THRESHOLDS,
  PROBE_DISTINCT_IPS,
  CROSS_STORE_PROBE_STORES,
  type AgentDenialRow,
} from '@api/mcp/agent-denial-alerts';

/** n rows for one store, all with the same credential outcome and IP spread. */
function rows(opts: {
  storeId: string;
  credential: string;
  count: number;
  ips: number;
  tool?: string;
  hadPriorAgentActivity?: boolean;
}): AgentDenialRow[] {
  return Array.from({ length: opts.count }, (_, i) => ({
    storeId: opts.storeId,
    storeName: `Store ${opts.storeId}`,
    storeSlug: opts.storeId,
    credential: opts.credential,
    ipAddress: `10.0.0.${i % opts.ips}`,
    tool: opts.tool ?? 'place_order',
    storeHadPriorAgentActivity: opts.hadPriorAgentActivity ?? false,
  }));
}

describe('classifyAgentDenials — silence is the normal answer', () => {
  it('returns nothing for an empty window', () => {
    expect(classifyAgentDenials([])).toEqual([]);
  });

  it('ignores rows with no usable storeId rather than throwing', () => {
    const junk = [
      { storeId: '', credential: 'invalid' },
      { storeId: undefined as unknown as string, credential: 'invalid' },
    ] as AgentDenialRow[];
    expect(classifyAgentDenials(junk)).toEqual([]);
  });
});

describe('integration_broken — a credential presented from a stable source', () => {
  const under = DENIAL_THRESHOLDS.integrationBroken - 1;
  const at = DENIAL_THRESHOLDS.integrationBroken;

  it(`does NOT fire at ${under} refusals`, () => {
    expect(
      classifyAgentDenials(rows({ storeId: 'a', credential: 'invalid', count: under, ips: 1 }))
    ).toEqual([]);
  });

  it(`fires p1, store-scoped, at ${at} refusals`, () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'invalid', count: at, ips: 1 })
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('integration_broken');
    expect(found[0].level).toBe('p1');
    expect(found[0].scope).toBe('store');
    expect(found[0].store?.id).toBe('a');
    expect(found[0].count).toBe(at);
  });

  it('treats a revoked key (credential="unconfigured") the same as a stale one', () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'unconfigured', count: at, ips: 1 })
    );
    expect(found.map(f => f.kind)).toEqual(['integration_broken']);
  });

  it(`stays integration_broken at the widest non-probing spread (${PROBE_DISTINCT_IPS - 1} IPs)`, () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'invalid', count: at, ips: PROBE_DISTINCT_IPS - 1 })
    );
    expect(found.map(f => f.kind)).toEqual(['integration_broken']);
  });
});

describe('rows with no recorded source address', () => {
  it('count as ONE source, so a broken integration is not relabelled a sweep', () => {
    // An absent `ip_address` is a platform/proxy condition affecting every row
    // equally, not evidence of many callers. Treating each as distinct (the
    // first version of `ipKey` did) flips this finding to `credential_probing`
    // AND raises its firing threshold from 3 to 10 — so the operator hunts an
    // attacker instead of calling the merchant, and the alert the low threshold
    // exists for fires late or not at all.
    const noIpRows: AgentDenialRow[] = Array.from(
      { length: DENIAL_THRESHOLDS.integrationBroken },
      () => ({
        storeId: 'a',
        storeName: 'Store a',
        credential: 'invalid',
        ipAddress: null,
        tool: 'place_order',
      })
    );
    const found = classifyAgentDenials(noIpRows);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('integration_broken');
    expect(found[0].distinctIps).toBe(1);
  });

  it('an empty-string ip is the same bucket as a null one', () => {
    const mixed: AgentDenialRow[] = [
      { storeId: 'a', credential: 'invalid', ipAddress: null },
      { storeId: 'a', credential: 'invalid', ipAddress: '' },
      { storeId: 'a', credential: 'invalid', ipAddress: undefined },
    ];
    const found = classifyAgentDenials(mixed);
    expect(found[0].distinctIps).toBe(1);
    expect(found[0].kind).toBe('integration_broken');
  });
});

describe('credential_probing — the same refusals, spread across sources', () => {
  const under = DENIAL_THRESHOLDS.credentialProbing - 1;
  const at = DENIAL_THRESHOLDS.credentialProbing;

  it(`the IP spread alone reclassifies it: ${DENIAL_THRESHOLDS.integrationBroken} refusals from ${PROBE_DISTINCT_IPS} IPs is NOT an alert`, () => {
    // Above the integration threshold but below the probing one — the whole
    // point of having two thresholds. A single threshold would page here.
    expect(
      classifyAgentDenials(
        rows({
          storeId: 'a',
          credential: 'invalid',
          count: DENIAL_THRESHOLDS.integrationBroken,
          ips: PROBE_DISTINCT_IPS,
        })
      )
    ).toEqual([]);
  });

  it(`does NOT fire at ${under} refusals`, () => {
    expect(
      classifyAgentDenials(
        rows({ storeId: 'a', credential: 'invalid', count: under, ips: PROBE_DISTINCT_IPS })
      )
    ).toEqual([]);
  });

  it(`fires p1, store-scoped, at ${at} refusals from ${PROBE_DISTINCT_IPS}+ IPs`, () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'invalid', count: at, ips: PROBE_DISTINCT_IPS })
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('credential_probing');
    expect(found[0].level).toBe('p1');
    expect(found[0].scope).toBe('store');
    expect(found[0].distinctIps).toBe(PROBE_DISTINCT_IPS);
  });

  it(`collapses ${CROSS_STORE_PROBE_STORES} probed stores into ONE platform p0 instead of ${CROSS_STORE_PROBE_STORES} store alerts`, () => {
    const input = ['a', 'b', 'c']
      .slice(0, CROSS_STORE_PROBE_STORES)
      .flatMap(storeId =>
        rows({ storeId, credential: 'invalid', count: at, ips: PROBE_DISTINCT_IPS })
      );
    const found = classifyAgentDenials(input);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('credential_probing');
    expect(found[0].level).toBe('p0');
    expect(found[0].scope).toBe('platform');
    expect(found[0].storesAffected).toBe(CROSS_STORE_PROBE_STORES);
    expect(found[0].count).toBe(at * CROSS_STORE_PROBE_STORES);
  });

  it(`stays per-store p1 at ${CROSS_STORE_PROBE_STORES - 1} probed stores`, () => {
    const input = ['a', 'b', 'c']
      .slice(0, CROSS_STORE_PROBE_STORES - 1)
      .flatMap(storeId =>
        rows({ storeId, credential: 'invalid', count: at, ips: PROBE_DISTINCT_IPS })
      );
    const found = classifyAgentDenials(input);
    expect(found).toHaveLength(CROSS_STORE_PROBE_STORES - 1);
    expect(found.every(f => f.level === 'p1' && f.scope === 'store')).toBe(true);
  });
});

describe('anonymous_flood — the expected background', () => {
  it('stays SILENT for credential-less attempts well past every other threshold', () => {
    // This is the mute-the-alert case. A crawler that read llms.txt and tried
    // `place_order` without a key is normal traffic, not an incident, and a
    // count-based alert would page on it from day one.
    expect(
      classifyAgentDenials(
        rows({
          storeId: 'a',
          credential: 'none',
          count: DENIAL_THRESHOLDS.anonymousFlood - 1,
          ips: 4,
        })
      )
    ).toEqual([]);
  });

  it(`fires at info level only, at ${DENIAL_THRESHOLDS.anonymousFlood}`, () => {
    const found = classifyAgentDenials(
      rows({
        storeId: 'a',
        credential: 'none',
        count: DENIAL_THRESHOLDS.anonymousFlood,
        ips: 4,
      })
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('anonymous_flood');
    expect(found[0].level).toBe('info');
  });

  it('keeps the floor high enough that ordinary crawler traffic never pages anyone', () => {
    // Pinned to LITERALS on purpose. Every other assertion in this file derives
    // its input from `DENIAL_THRESHOLDS`, which means lowering a threshold moves
    // the expectation with it and the test stays green for the wrong reason —
    // measured, not assumed: the mutation that set this floor to 1 SURVIVED
    // until this test existed, because `anonymousFlood - 1` then fed in zero
    // rows. A concrete count is the only thing that pins a quiet floor.
    expect(DENIAL_THRESHOLDS.anonymousFlood).toBeGreaterThanOrEqual(50);
    expect(
      classifyAgentDenials(rows({ storeId: 'a', credential: 'none', count: 20, ips: 4 }))
    ).toEqual([]);
    expect(
      classifyAgentDenials(rows({ storeId: 'a', credential: 'none', count: 49, ips: 6 }))
    ).toEqual([]);
  });

  it('a missing credential field counts as anonymous, never as a presented credential', () => {
    const found = classifyAgentDenials(
      Array.from({ length: DENIAL_THRESHOLDS.anonymousFlood }, (_, i) => ({
        storeId: 'a',
        credential: null,
        ipAddress: `10.0.0.${i % 4}`,
      }))
    );
    expect(found.map(f => f.kind)).toEqual(['anonymous_flood']);
  });
});

describe('platform_fault — our own failure, wearing the caller’s clothes', () => {
  const under = DENIAL_THRESHOLDS.platformFault - 1;
  const at = DENIAL_THRESHOLDS.platformFault;

  it(`does NOT fire at ${under} lookup errors (a single blip is not an incident)`, () => {
    expect(
      classifyAgentDenials(rows({ storeId: 'a', credential: 'error', count: under, ips: 1 }))
    ).toEqual([]);
  });

  it(`fires p0 at ${at} — a broken ENCRYPTION_KEY refuses every legitimate agent silently`, () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'error', count: at, ips: 1 })
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('platform_fault');
    expect(found[0].level).toBe('p0');
    expect(found[0].scope).toBe('platform');
  });

  it('never folds an "error" row into the presented-credential classes', () => {
    // `error` means the lookup blew up, NOT that a caller sent a bad key.
    // Counting it as `invalid` would blame a merchant for our outage.
    const found = classifyAgentDenials([
      ...rows({ storeId: 'a', credential: 'error', count: at, ips: 1 }),
      ...rows({
        storeId: 'a',
        credential: 'invalid',
        count: DENIAL_THRESHOLDS.integrationBroken - 1,
        ips: 1,
      }),
    ]);
    expect(found.map(f => f.kind)).toEqual(['platform_fault']);
  });
});

describe('platform_fault — #1653: spread thinly across many stores must still fire', () => {
  it('does not fire when each store is individually below threshold but no store reaches it alone (pre-fix behaviour)', () => {
    // Reproduces the exact shape the bug missed: 2 error rows in EACH of 5
    // stores is 10 platform-wide, but each bucket alone is below
    // `platformFault` (3). The pre-fix classifier (per-store only) found
    // nothing here; asserting the fix's actual behaviour below.
    const below = DENIAL_THRESHOLDS.platformFault - 1;
    const spread = ['a', 'b', 'c', 'd', 'e'].flatMap(storeId =>
      rows({ storeId, credential: 'error', count: below, ips: 1 })
    );
    const found = classifyAgentDenials(spread);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('platform_fault');
    expect(found[0].level).toBe('p0');
    expect(found[0].scope).toBe('platform');
    // Genuinely platform-scoped — no single store's field.
    expect(found[0].store).toBeUndefined();
    expect(found[0].storesAffected).toBe(5);
    expect(found[0].count).toBe(below * 5);
  });

  it('still fires when the fault is concentrated in one store (no regression)', () => {
    const found = classifyAgentDenials(
      rows({ storeId: 'a', credential: 'error', count: DENIAL_THRESHOLDS.platformFault, ips: 1 })
    );
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('platform_fault');
    expect(found[0].storesAffected).toBe(1);
  });

  it('does not fire when the platform-wide total is still below threshold', () => {
    const found = classifyAgentDenials([
      ...rows({ storeId: 'a', credential: 'error', count: 1, ips: 1 }),
      ...rows({ storeId: 'b', credential: 'error', count: 1, ips: 1 }),
    ]);
    expect(found.filter(f => f.kind === 'platform_fault')).toEqual([]);
  });
});

describe('multi-store windows', () => {
  it('scopes each finding to its own store and reports only the stores over threshold', () => {
    const found = classifyAgentDenials([
      ...rows({
        storeId: 'busy',
        credential: 'invalid',
        count: DENIAL_THRESHOLDS.integrationBroken,
        ips: 1,
      }),
      ...rows({
        storeId: 'quiet',
        credential: 'invalid',
        count: DENIAL_THRESHOLDS.integrationBroken - 1,
        ips: 1,
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].store?.id).toBe('busy');
  });

  it('reports the tools that were refused so the operator knows what broke', () => {
    const found = classifyAgentDenials([
      ...rows({
        storeId: 'a',
        credential: 'invalid',
        count: DENIAL_THRESHOLDS.integrationBroken,
        ips: 1,
        tool: 'add_to_cart',
      }),
      ...rows({ storeId: 'a', credential: 'invalid', count: 1, ips: 1, tool: 'place_order' }),
    ]);
    expect(found[0].tools).toEqual(['add_to_cart', 'place_order']);
  });
});

describe('integration_never_credentialed — the rollout breaking someone quietly', () => {
  /**
   * The failure this whole change set actually causes.
   *
   * An integration that worked before the credential existed sends no header,
   * so it lands in the same bucket as a crawler: `credential: 'none'`. At the
   * `anonymous_flood` threshold of 50 per 16-minute window, a real merchant
   * losing ten orders an hour produces NOTHING — not even the info line. The
   * one signature the monitor most needs to catch was the one it was built to
   * ignore. Prior agent volume is what separates the two populations.
   */

  it('pages at 3 when the store has transacted by agent before', () => {
    const findings = classifyAgentDenials(
      rows({ storeId: 's1', credential: 'none', count: 3, ips: 1, hadPriorAgentActivity: true })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('integration_never_credentialed');
    expect(findings[0].level).toBe('p1');
    expect(findings[0].count).toBe(3);
  });

  it('stays quiet below the threshold', () => {
    const findings = classifyAgentDenials(
      rows({ storeId: 's1', credential: 'none', count: 2, ips: 1, hadPriorAgentActivity: true })
    );
    expect(findings).toEqual([]);
  });

  it('does NOT page for a store with no agent history — that is crawler noise', () => {
    // Same rows, same volume, one flag different. Without this the change
    // would page on every scanner that ever touched a public /mcp endpoint,
    // because at deploy NO store has a key.
    const findings = classifyAgentDenials(
      rows({ storeId: 's1', credential: 'none', count: 20, ips: 4, hadPriorAgentActivity: false })
    );
    expect(findings).toEqual([]);
  });

  it('still reports genuine anonymous volume as info for a no-history store', () => {
    const findings = classifyAgentDenials(
      rows({ storeId: 's1', credential: 'none', count: 50, ips: 6, hadPriorAgentActivity: false })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('anonymous_flood');
    expect(findings[0].level).toBe('info');
  });

  it('reports a prior-agent store ONCE, not as both classes', () => {
    // 60 rows clears the flood threshold too; the two arms must be exclusive
    // or one incident pages and files an info line for the same rows.
    const findings = classifyAgentDenials(
      rows({ storeId: 's1', credential: 'none', count: 60, ips: 2, hadPriorAgentActivity: true })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('integration_never_credentialed');
  });

  it('treats a missing flag as no history, so the default cannot page', () => {
    const bare = [
      { storeId: 's1', credential: 'none' },
      { storeId: 's1', credential: 'none' },
      { storeId: 's1', credential: 'none' },
    ] as AgentDenialRow[];
    expect(classifyAgentDenials(bare)).toEqual([]);
  });
});
