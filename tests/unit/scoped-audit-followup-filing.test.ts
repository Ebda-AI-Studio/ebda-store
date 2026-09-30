/**
 * The scoped-audit gate's issue-filing policy.
 *
 * Both cases below are the two defects that let the followup backlog reach 703
 * open issues, 241 of them filed in the two days the audit spent reviewing the
 * pull requests that were fixing its own earlier findings.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchOpenFollowupTitles,
  followupIssueTitle,
  selectFollowupsToFile,
  followupFingerprint,
  fingerprintMarker,
  extractFingerprint,
  locationCommentMarker,
  findMarkedComment,
  groupCommentsByIssue,
  buildLocationCommentBody,
  LOCATION_COMMENT_MAX_CHARS,
  // @ts-expect-error - plain .mjs script, no types
} from '../../.github/scoped-audit/followup-filing.mjs';
// @ts-expect-error - plain .mjs script, no types
import { fetchAllPages } from '../../.github/scoped-audit/gh-paginate.mjs';
// @ts-expect-error - plain .mjs script, no types
import { resolveMarkerComment } from '../../.github/scoped-audit/marker-comment.mjs';
// @ts-expect-error - plain .mjs script, no types
import { nonRunExitCode, auditExitCode } from '../../.github/scoped-audit/gate-policy.mjs';

type Finding = { severity: string; title: string };

/** A gh() stub serving `total` open followups, 100 per page, like the API. */
function ghServing(total: number, { prsOnFirstPage = 0 } = {}) {
  const calls: string[] = [];
  const gh = async (_method: string, path: string) => {
    calls.push(path);
    const page = Number(new URL(`https://x${path}`).searchParams.get('page') ?? '1');
    const start = (page - 1) * 100;
    const batch: Array<Record<string, unknown>> = [];
    for (let i = start; i < Math.min(start + 100, total); i++) {
      batch.push({ title: `[audit-followup][P3] finding ${i}` });
    }
    if (page === 1) {
      for (let i = 0; i < prsOnFirstPage; i++) {
        batch.push({ title: `a pull request ${i}`, pull_request: { url: 'x' } });
      }
    }
    return { ok: true, json: async () => batch };
  };
  return { gh, calls };
}

describe('dedup sees every open followup, not just the first page', () => {
  it('pages past 100 — the finding it must dedup against sat at position 650', async () => {
    const { gh, calls } = ghServing(703);
    const { titles, complete } = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });

    expect(complete).toBe(true);
    expect(titles.size, 'a single page would have collected 100').toBe(703);
    expect(calls.length, 'must have requested more than one page').toBeGreaterThan(1);
    expect(titles.has('[audit-followup][P3] finding 650')).toBe(true);
  });

  it('does not count pull requests as tracked issues', async () => {
    const { gh } = ghServing(50, { prsOnFirstPage: 7 });
    const { titles } = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(titles.size).toBe(50);
  });

  it('stops on a short page rather than requesting forever', async () => {
    const { gh, calls } = ghServing(150);
    await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(calls.length, 'page 2 is short, so there is no page 3').toBe(2);
  });

  it('reports an API refusal as INCOMPLETE, not as an empty backlog', async () => {
    const gh = async () => ({ ok: false, json: async () => [] });
    const r = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(r.titles).toEqual(new Set());
    expect(r.complete, 'an empty result must not pass for a read backlog').toBe(false);
  });

  it('reports a thrown fetch as incomplete — the real failure mode observed', async () => {
    const gh = async () => {
      throw new Error('fetch failed');
    };
    const r = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(r.complete).toBe(false);
  });

  it('reports a mid-pagination failure as incomplete', async () => {
    let n = 0;
    const gh = async () => {
      n++;
      if (n === 1)
        return {
          ok: true,
          json: async () => Array.from({ length: 100 }, (_, i) => ({ title: `t${i}` })),
        };
      return { ok: false, json: async () => [] };
    };
    const r = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(r.titles.size, 'it keeps what it read').toBe(100);
    expect(r.complete, 'but must not act on a prefix').toBe(false);
  });
});

describe('a single run cannot flood the tracker', () => {
  // All trackable, so these cases exercise the cap rather than the severity
  // floor — P1 first so the ordering case has something to order.
  const many: Finding[] = Array.from({ length: 25 }, (_, i) => ({
    severity: i < 4 ? 'P1' : 'P2',
    title: `finding ${i}`,
  }));

  it('caps the run and reports what it held back', () => {
    const r = selectFollowupsToFile({ followups: many, openTitles: new Set(), cap: 10 });
    expect(r.toFile).toHaveLength(10);
    expect(r.overCap).toHaveLength(15);
    expect(r.toFile.length + r.overCap.length + r.alreadyTracked.length).toBe(25);
  });

  it('spends the cap by severity — it bounds volume, not importance', () => {
    const r = selectFollowupsToFile({ followups: many, openTitles: new Set(), cap: 10 });
    expect(r.toFile.slice(0, 4).every((f: Finding) => f.severity === 'P1')).toBe(true);
    expect(r.overCap.every((f: Finding) => f.severity === 'P2')).toBe(true);
  });

  it('skips one already tracked, and that does not consume the cap', () => {
    const openTitles = new Set([followupIssueTitle(many[0])]);
    const r = selectFollowupsToFile({ followups: many, openTitles, cap: 10 });
    expect(r.alreadyTracked).toHaveLength(1);
    expect(r.toFile, 'the freed slot goes to the next finding').toHaveLength(10);
    expect(r.toFile.map(followupIssueTitle)).not.toContain(followupIssueTitle(many[0]));
  });

  it('does not file the same title twice within one run', () => {
    const dupes: Finding[] = [
      { severity: 'P2', title: 'same defect' },
      { severity: 'P2', title: 'same defect' },
    ];
    const r = selectFollowupsToFile({ followups: dupes, openTitles: new Set(), cap: 10 });
    expect(r.toFile).toHaveLength(1);
    expect(r.alreadyTracked).toHaveLength(1);
  });

  it('files everything when the run is under the cap', () => {
    const few: Finding[] = [{ severity: 'P2', title: 'a' }];
    const r = selectFollowupsToFile({ followups: few, openTitles: new Set(), cap: 10 });
    expect(r.toFile).toHaveLength(1);
    expect(r.overCap).toHaveLength(0);
  });

  it('#1752: also caps the toComment (already-tracked-location) path', () => {
    // Every entry below resolves to an already-open issue at the SAME
    // location, so with no cap of its own every one would land in
    // `toComment` — one paginated read plus one write each, unbounded.
    const sameLocation = Array.from({ length: 5 }, (_, i) => ({
      severity: 'P2',
      title: `worded differently ${i}`,
      dimension: 'security',
      file: 'apps/api/src/services/order.service.ts',
    }));
    const fp = 'security|apps/api/src/services/order.service.ts';
    const r = selectFollowupsToFile({
      followups: sameLocation,
      openTitles: new Set(),
      openFingerprints: new Map([[fp, 4242]]),
      cap: 10,
      commentCap: 2,
    });
    expect(r.toComment).toHaveLength(2);
    expect(r.overCap).toHaveLength(3);
    expect(r.toFile).toHaveLength(0);
    expect(r.toComment.length + r.overCap.length).toBe(sameLocation.length);
  });

  it('#1752: defaults commentCap to cap for an older caller that only passes cap', () => {
    const sameLocation = Array.from({ length: 4 }, (_, i) => ({
      severity: 'P2',
      title: `worded differently ${i}`,
      dimension: 'security',
      file: 'apps/api/src/services/order.service.ts',
    }));
    const fp = 'security|apps/api/src/services/order.service.ts';
    const r = selectFollowupsToFile({
      followups: sameLocation,
      openTitles: new Set(),
      openFingerprints: new Map([[fp, 4242]]),
      cap: 2,
    });
    expect(r.toComment).toHaveLength(2);
    expect(r.overCap).toHaveLength(2);
  });
});

describe('fetchAllPages — the shared rule both call sites now use', () => {
  it('reads a list endpoint that already has a query string', async () => {
    const seen: string[] = [];
    const gh = async (_m: string, path: string) => {
      seen.push(path);
      return { ok: true, json: async () => [] };
    };
    await fetchAllPages({ gh, path: '/repos/o/r/issues?state=open' });
    expect(seen[0]).toBe('/repos/o/r/issues?state=open&per_page=100&page=1');
  });

  it('reads one with no query string', async () => {
    const seen: string[] = [];
    const gh = async (_m: string, path: string) => {
      seen.push(path);
      return { ok: true, json: async () => [] };
    };
    await fetchAllPages({ gh, path: '/repos/o/r/issues/5/comments' });
    expect(seen[0]).toBe('/repos/o/r/issues/5/comments?per_page=100&page=1');
  });

  it('concatenates every page', async () => {
    const gh = async (_m: string, path: string) => {
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
      const n = page === 1 ? 100 : page === 2 ? 100 : 12;
      return { ok: true, json: async () => Array.from({ length: n }, (_, i) => ({ i })) };
    };
    const { items, complete } = await fetchAllPages({ gh, path: '/x' });
    expect(items).toHaveLength(212);
    expect(complete).toBe(true);
  });

  it('honours maxPages rather than looping forever', async () => {
    let calls = 0;
    const gh = async () => {
      calls++;
      return { ok: true, json: async () => Array.from({ length: 100 }, (_, i) => ({ i })) };
    };
    const { complete } = await fetchAllPages({ gh, path: '/x', maxPages: 3 });
    expect(calls).toBe(3);
    expect(complete, 'hitting the page cap means the set was not fully read').toBe(false);
  });
});

describe('an unreadable backlog files nothing', () => {
  const findings = [
    { severity: 'P2', title: 'a' },
    { severity: 'P2', title: 'b' },
  ];

  it('files none of them rather than filing against an unknown baseline', () => {
    const r = selectFollowupsToFile({
      followups: findings,
      openTitles: new Set(),
      cap: 10,
      dedupComplete: false,
    });
    expect(r.toFile, 'this is the run that mints duplicates').toHaveLength(0);
    expect(r.dedupIncomplete).toBe(true);
    expect(r.overCap, 'nothing is dropped — they stay reported').toHaveLength(2);
  });

  it('files normally once the backlog reads cleanly', () => {
    const r = selectFollowupsToFile({
      followups: findings,
      openTitles: new Set(),
      cap: 10,
      dedupComplete: true,
    });
    expect(r.toFile).toHaveLength(2);
    expect(r.dedupIncomplete).toBe(false);
  });
});

describe('P3 is reported on the PR and never becomes an issue', () => {
  const mixed = [
    { severity: 'P2', title: 'tracked one' },
    { severity: 'P3', title: 'comment only' },
    { severity: 'P3', title: 'comment only too' },
  ];

  it('files the P2 and records the P3s as untracked', () => {
    const r = selectFollowupsToFile({ followups: mixed, openTitles: new Set(), cap: 10 });
    expect(r.toFile.map((f: { title: string }) => f.title)).toEqual(['tracked one']);
    expect(r.untracked, 'still reported, just not filed').toHaveLength(2);
  });

  it('does not spend the cap on findings it will not file', () => {
    const many = [
      ...Array.from({ length: 40 }, (_, i) => ({ severity: 'P3', title: `p3 ${i}` })),
      { severity: 'P2', title: 'the one that matters' },
    ];
    const r = selectFollowupsToFile({ followups: many, openTitles: new Set(), cap: 10 });
    expect(r.toFile).toHaveLength(1);
    expect(r.toFile[0].title).toBe('the one that matters');
  });

  it('still files a P0/P1 if one is ever produced as a followup', () => {
    const r = selectFollowupsToFile({
      followups: [{ severity: 'P1', title: 'blocking' }],
      openTitles: new Set(),
      cap: 10,
    });
    expect(r.toFile, 'the floor must not swallow a blocking finding').toHaveLength(1);
  });

  it('a run of only P3 files nothing at all', () => {
    const r = selectFollowupsToFile({
      followups: [{ severity: 'P3', title: 'x' }],
      openTitles: new Set(),
      cap: 10,
    });
    expect(r.toFile).toHaveLength(0);
    expect(r.untracked).toHaveLength(1);
  });
});

describe('finding the gate own PR comment', () => {
  const MARKER = '<!-- scoped-audit-bot -->';
  const withMarker = { id: 7, body: `${MARKER}\n### Scoped Audit` };
  const other = { id: 1, body: 'a human review comment' };

  it('returns the marker comment to edit', () => {
    const r = resolveMarkerComment({ items: [other, withMarker], complete: true, marker: MARKER });
    expect(r.prior?.id).toBe(7);
    expect(r.uncertain).toBe(false);
  });

  it('returns null when the full list genuinely has none', () => {
    const r = resolveMarkerComment({ items: [other], complete: true, marker: MARKER });
    expect(r.prior).toBeNull();
    expect(r.uncertain, 'a complete read establishes absence').toBe(false);
  });

  it('flags a null it could not establish, but still lets the caller post', () => {
    // Refusing here would turn an untidy PR into an unreported finding: this
    // comment is the only place P3 and over-cap findings are ever written.
    const r = resolveMarkerComment({ items: [other], complete: false, marker: MARKER });
    expect(r.prior).toBeNull();
    expect(r.uncertain).toBe(true);
  });

  it('trusts a marker it did find, even on a partial read', () => {
    const r = resolveMarkerComment({ items: [withMarker], complete: false, marker: MARKER });
    expect(r.prior?.id).toBe(7);
    expect(r.uncertain, 'nothing uncertain about a comment we are holding').toBe(false);
  });

  it('survives comments with a null or missing body', () => {
    const r = resolveMarkerComment({
      items: [{ id: 2, body: null }, {}, withMarker],
      complete: true,
      marker: MARKER,
    });
    expect(r.prior?.id).toBe(7);
  });

  it('consumes exactly what fetchAllPages returns — the shape that shipped broken', async () => {
    const gh = async () => ({ ok: true, json: async () => [withMarker] });
    const page = await fetchAllPages({ gh, path: '/repos/o/r/issues/1/comments' });
    // If this destructure ever drifts again, this line fails at the boundary.
    const r = resolveMarkerComment({ ...page, marker: MARKER });
    expect(r.prior?.id).toBe(7);
  });
});

describe('a gate that did not run must not report success', () => {
  // Observed 2026-09-03 on this very PR: `claude CLI exited 1 — the
  // scoped-audit gate did not run`, `AUDIT_RAN: false`, and the check reported
  // completed/success. A run that audited nothing looked exactly like one that
  // audited everything and approved it.
  it('exits non-zero when nothing was audited', () => {
    expect(nonRunExitCode()).toBe(1);
  });

  it('stays fail-open where a red tick WOULD block', () => {
    // The policy is "must not block every PR on a model outage". That holds
    // because this gate is not a required check. If it ever becomes one, the
    // same non-run must go back to exiting zero or the trade-off inverts.
    expect(nonRunExitCode({ isRequiredCheck: true })).toBe(0);
  });

  it('a completed audit still gates on its findings, not on having run', () => {
    expect(auditExitCode({ blockingFindings: 0 })).toBe(0);
    expect(auditExitCode({ blockingFindings: 1 })).toBe(1);
  });
});

describe('#1453: a failed marker-comment write is reported, not swallowed', () => {
  // gh() logs a non-ok response but never throws, so the `catch` around
  // upsertMarkerComment only ever fired on a thrown network error — never on
  // an HTTP rejection (a comment over GitHub's 65536-char limit, a token
  // missing `pull-requests: write`, a secondary rate limit). This comment is
  // the ONLY place P3 and over-cap findings are ever reported, so a silent
  // HTTP failure here loses them with no trace anywhere. Both the audit gate
  // and its sibling ai-review gate share the same gh() shape (CLAUDE.md: "fix
  // the class, not the instance").
  const auditSource = readFileSync(
    new URL('../../.github/scoped-audit/audit.mjs', import.meta.url),
    'utf8'
  );
  const reviewSource = readFileSync(
    new URL('../../.github/ai-review/review.mjs', import.meta.url),
    'utf8'
  );

  it('upsertMarkerComment checks resp.ok before returning', () => {
    const fn = auditSource.match(/async function upsertMarkerComment\([\s\S]*?\n}\n/)?.[0];
    expect(fn, 'upsertMarkerComment not found').toBeTruthy();
    expect(fn).toMatch(/resp\.ok/);
    expect(fn).toMatch(/::error::/);
  });

  it('review.mjs checks the fallback comment response too', () => {
    expect(reviewSource).toMatch(/fallback\.ok/);
  });
});

describe('every path that admits it did not audit must exit non-zero', () => {
  // Three of these were fixed and a FOURTH was missed, which the gate itself
  // caught on the next run. Then THREE MORE were found — the pre-flight guards
  // — which this test could not see at all, because it keyed on the name of the
  // alert function and those paths did not alert. A test that certifies an
  // invariant it cannot observe is worse than no test.
  //
  // So it no longer looks for a function name. It looks at every zero-exit in
  // the file. Any new early return has to justify itself here.
  const source = readFileSync(
    new URL('../../.github/scoped-audit/audit.mjs', import.meta.url),
    'utf8'
  );
  const lines = source.split('\n');

  const zeroExits = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /process\.exit\(\s*0\s*\)/.test(line));

  // #1521: workflow_dispatch has no PR to audit by construction (the trigger
  // is explicitly supported — the recovery text in alertAuditDidNotRun below
  // even tells an operator to use it) — that is an expected no-op, not a
  // failure, and is the ONE early exit(0) allowed to exist alongside the
  // terminal success. It must be conditioned on the trigger not being
  // `pull_request`, so it cannot mask a genuinely PR-triggered run with no
  // PR_NUMBER — that case still falls through to nonRunExitCode().
  const EXPECTED_EARLY_ZERO_EXITS = 1;

  it(`has exactly ${EXPECTED_EARLY_ZERO_EXITS} justified early exit(0), and a terminal exit that reads the verdict`, () => {
    // The terminal exit used to be a literal `process.exit(0)`. It now goes
    // through gate-policy's auditExitCode(), so a PARTIAL (truncated) audit
    // with nothing blocking cannot exit green (scoped audit, PR 1978).
    expect(
      zeroExits.length,
      `exit(0) at lines ${zeroExits.map(z => z.n).join(', ')} — every early exit must use ` +
        `nonRunExitCode() unless justified here`
    ).toBe(EXPECTED_EARLY_ZERO_EXITS);
    const nonEmpty = lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.trim().length > 0);
    expect(nonEmpty[nonEmpty.length - 1].l.trim()).toBe(
      'process.exit(auditExitCode({ blockingFindings: 0, partial }));'
    );
  });

  it('the early exit(0) is gated on a non-pull_request trigger', () => {
    const early = zeroExits;
    expect(early).toHaveLength(EXPECTED_EARLY_ZERO_EXITS);
    for (const z of early) {
      const before = lines.slice(Math.max(0, z.n - 12), z.n - 1).join('\n');
      expect(
        /GITHUB_EVENT_NAME/.test(before),
        `line ${z.n} exits 0 early without checking GITHUB_EVENT_NAME — an unconditional or ` +
          `differently-guarded early exit(0) needs its own justification here`
      ).toBe(true);
    }
  });

  it('no exit sits under a line admitting it skipped', () => {
    // Catches the shape regardless of how the skip is worded or reported. The
    // #1521 no-op deliberately says "expected"/"not a failure" rather than any
    // of these words, precisely so this stays a true admission-of-failure check.
    const admits = /skipping|fail-open|did NOT run|not set|missing|malformed/i;
    for (const z of zeroExits) {
      const before = lines.slice(Math.max(0, z.n - 6), z.n - 1).join('\n');
      expect(
        admits.test(before),
        `line ${z.n} exits 0 right after admitting it did not audit`
      ).toBe(false);
    }
  });

  it('every non-run path routes through the shared policy', () => {
    const policyExits = lines.filter(l => l.includes('process.exit(nonRunExitCode())'));
    expect(policyExits.length, 'expected the four parse/sentinel paths plus three pre-flight').toBe(
      7
    );
  });
});

/**
 * Defect 3: the dedup key was the model-written TITLE.
 *
 * Filed as #116 on the day the gate shipped, left open, and it is the reason
 * the backlog reached 929 open followups across 315 files by 2026-09-11: the
 * gate runs on every push to a PR, and the same underlying defect phrased
 * slightly differently on the next run missed the exact-match check.
 *
 * The fix keys on the LOCATION instead — dimension, file, line — carried as a
 * hidden marker in the issue body. The interesting half is what happens on a
 * match: a location key's own failure mode is the opposite one (two genuinely
 * different defects at one line collapsing into a single issue, with the second
 * silently gone), so a match returns the finding for COMMENTING onto the
 * existing issue rather than dropping it. Both halves are tested.
 */
describe('location fingerprint dedup (#116)', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    severity: 'P2',
    title: 'something is wrong',
    dimension: 'security',
    file: 'apps/api/src/services/order.service.ts',
    line: 412,
    ...over,
  });

  it('builds a fingerprint from location, not from the title', () => {
    const a = followupFingerprint(finding({ title: 'Cart total can go negative' }));
    const b = followupFingerprint(finding({ title: 'negative cart total is reachable' }));
    expect(a).toBe(b);
  });

  it('separates two different files', () => {
    expect(followupFingerprint(finding())).not.toBe(
      followupFingerprint(finding({ file: 'apps/api/src/services/cart.service.ts' }))
    );
  });

  it('#1738: does NOT separate two different lines in one file', () => {
    // `line` used to be part of the key. prompt.md explicitly permits the
    // model to cite an "approx line N" guess, and the reviewed file keeps
    // changing between pushes (that is why there was a push) — so a line
    // number, exact or estimated, was the least stable part of a finding's
    // identity and drifted the fingerprint on every push it did not close.
    // Dropping it means the same file/dimension always fingerprints the same,
    // regardless of which line the model cited this run.
    expect(followupFingerprint(finding())).toBe(followupFingerprint(finding({ line: 900 })));
    expect(followupFingerprint(finding({ line: undefined }))).toBe(followupFingerprint(finding()));
  });

  it('round-trips through the hidden marker', () => {
    const f = finding();
    const body = `**Detail:** x\n\n${fingerprintMarker(f)}`;
    expect(extractFingerprint(body)).toBe(followupFingerprint(f));
  });

  it('returns null for a body with no marker — the 929 already-open issues', () => {
    expect(extractFingerprint('an issue filed before the marker existed')).toBeNull();
    expect(extractFingerprint(undefined as unknown as string)).toBeNull();
  });

  it('#1744: reads the LAST marker, not the first', () => {
    // Body composition (audit.mjs) interpolates model-authored detail/fix/
    // blastRadius text BEFORE the real trailing marker it appends last. This
    // gate audits itself, so a finding ABOUT the fingerprint scheme can quote
    // a marker literal inside its own detail — the shape below is that case.
    const body =
      `**Detail:** quotes a literal <!-- audit-fp:security|a.ts|1 --> in its own text\n\n` +
      `<!-- audit-fp:contract-drift|followup-filing.mjs|125 -->`;
    // Legacy three-part marker, normalised to the current two-part key.
    expect(extractFingerprint(body)).toBe('contract-drift|followup-filing.mjs');
  });

  it('a LEGACY dimension|file|line marker still matches the current dimension|file key', () => {
    // Scoped audit, PR 1978: #1738 dropped `|line` from the key, and 195 of
    // the 200 open audit-followup issues carried the old three-part marker.
    // Read back verbatim, none matched, and each would have been filed again.
    const f = finding({ line: 7 });
    const legacyBody = `**Detail:** x\n\n<!-- audit-fp:security|${f.file}|412 -->`;
    expect(extractFingerprint(legacyBody)).toBe(followupFingerprint(f));
  });

  it('a legacy-marked open issue dedups a new finding end to end (fetch → select)', async () => {
    const f = finding({ title: 'reworded since it was filed', line: 30 });
    const gh = async () => ({
      ok: true,
      json: async () => [
        {
          number: 777,
          title: '[audit-followup][P2] the original wording',
          body: `old issue\n<!-- audit-fp:security|${f.file}|412 -->`,
        },
      ],
    });
    const { titles, fingerprints } = await fetchOpenFollowupTitles({
      gh: gh as any,
      owner: 'o',
      repo: 'r',
    });
    const res = selectFollowupsToFile({
      followups: [f],
      openTitles: titles,
      openFingerprints: fingerprints,
      cap: 10,
    });
    expect(res.toFile).toHaveLength(0);
    expect(res.toComment).toEqual([{ finding: f, issueNumber: 777 }]);
  });

  it('COMMENTS a reworded finding onto the open issue instead of filing again', () => {
    const f = finding({ title: 'a completely different wording' });
    const res = selectFollowupsToFile({
      followups: [f],
      openTitles: new Set<string>(), // title does NOT match — this is the defect
      openFingerprints: new Map([[followupFingerprint(f), 4242]]),
      cap: 10,
    });
    expect(res.toFile).toHaveLength(0);
    expect(res.toComment).toEqual([{ finding: f, issueNumber: 4242 }]);
  });

  it('still files a finding at a location nothing tracks yet', () => {
    const f = finding();
    const res = selectFollowupsToFile({
      followups: [f],
      openTitles: new Set<string>(),
      openFingerprints: new Map([['security|other/file.ts|1', 1]]),
      cap: 10,
    });
    expect(res.toFile).toEqual([f]);
    expect(res.toComment).toHaveLength(0);
  });

  it('files the first of two same-location findings and comments the second onto it', () => {
    // Within one run the issue number is not known until the first is filed,
    // so the second is held with a null number for the caller to resolve.
    const a = finding({ title: 'first defect here' });
    const b = finding({ title: 'second, different defect at the same line' });
    const res = selectFollowupsToFile({
      followups: [a, b],
      openTitles: new Set<string>(),
      openFingerprints: new Map(),
      cap: 10,
    });
    expect(res.toFile).toEqual([a]);
    expect(res.toComment).toHaveLength(1);
    expect(res.toComment[0].finding).toBe(b);
    expect(res.toComment[0].issueNumber).toBeNull();
    expect(res.toComment[0].sameRunFingerprint).toBe(followupFingerprint(a));
  });

  it('nothing is dropped: every tracked finding lands in exactly one bucket', () => {
    const fs = [
      finding({ title: 'x', line: 1 }),
      finding({ title: 'y', line: 1 }),
      finding({ title: 'z', line: 2 }),
      finding({ title: 'w', line: 3, severity: 'P3' }),
    ];
    const res = selectFollowupsToFile({
      followups: fs,
      openTitles: new Set<string>(),
      openFingerprints: new Map([[followupFingerprint(finding({ line: 3 })), 7]]),
      cap: 10,
    });
    const seen = [
      ...res.toFile,
      ...res.alreadyTracked,
      ...res.overCap,
      ...res.untracked,
      ...res.toComment.map((c: { finding: unknown }) => c.finding),
    ];
    expect(new Set(seen).size).toBe(fs.length);
  });

  it('degrades to title-only behaviour when no fingerprints are supplied', () => {
    // An older caller, or a repo whose open issues all predate the marker.
    const f = finding();
    const res = selectFollowupsToFile({ followups: [f], openTitles: new Set<string>(), cap: 10 });
    expect(res.toFile).toEqual([f]);
  });

  it('files nothing and comments nothing when the dedup baseline could not be read', () => {
    const f = finding();
    const res = selectFollowupsToFile({
      followups: [f],
      openTitles: new Set<string>(),
      openFingerprints: new Map(),
      cap: 10,
      dedupComplete: false,
    });
    expect(res.toFile).toHaveLength(0);
    expect(res.toComment).toHaveLength(0);
    expect(res.dedupIncomplete).toBe(true);
  });

  /**
   * Defect 4: the COMMENT path had no idempotency of its own.
   *
   * `toComment` is reached precisely when a defect persists and the model
   * rewords it — and the gate runs on every push to a PR. Posting
   * unconditionally would have left one new comment per push per issue,
   * indefinitely: #116's 929 duplicate issues become a smaller set of issues
   * each growing a comment per push. The same unbounded growth, relocated.
   */
  describe('the comment path is idempotent across runs', () => {
    const fp = 'security|apps/api/src/services/order.service.ts|412';

    it('keys the marker on location and PR — not on the title, not on the commit', () => {
      const a = locationCommentMarker({ fingerprint: fp, pr: '77' });
      expect(a).toBe(locationCommentMarker({ fingerprint: fp, pr: '77' }));
      // A per-commit key is the one that reproduces the bug: every push is a
      // new SHA, so every push would miss and post again.
      expect(a).not.toContain('abc1234');
      expect(a).toContain(fp);
      expect(a).toContain('pr-77');
      // A different PR re-reporting the same location is genuinely new news.
      expect(a).not.toBe(locationCommentMarker({ fingerprint: fp, pr: '78' }));
    });

    it('finds its own prior comment so the second run edits instead of posting', () => {
      const marker = locationCommentMarker({ fingerprint: fp, pr: '77' });
      const items = [
        { id: 1, body: 'a human said something' },
        { id: 2, body: `**Also reported at this location**\n\n${marker}` },
      ];
      expect(findMarkedComment(items, marker)?.id).toBe(2);
    });

    it('does not mistake another PR comment, or another location, for its own', () => {
      const marker = locationCommentMarker({ fingerprint: fp, pr: '77' });
      const items = [
        { id: 3, body: locationCommentMarker({ fingerprint: fp, pr: '78' }) },
        { id: 4, body: locationCommentMarker({ fingerprint: 'security|other.ts|1', pr: '77' }) },
        { id: 5, body: null },
        {},
      ];
      expect(findMarkedComment(items, marker)).toBeNull();
    });

    it('survives an issue whose comments could not be read', () => {
      expect(findMarkedComment([], null)).toBeNull();
      expect(findMarkedComment(undefined, 'x')).toBeNull();
    });

    it('collapses same-location findings into ONE comment, losing neither', () => {
      // This is what lets the marker key on location alone: two genuinely
      // different defects at one line share a marker, so they must share a body.
      const a = finding({ title: 'first defect' });
      const b = finding({ title: 'second, different defect at the same line' });
      const { groups, unresolved } = groupCommentsByIssue([
        { finding: a, issueNumber: 4242 },
        { finding: b, issueNumber: 4242 },
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].issueNumber).toBe(4242);
      expect(groups[0].findings).toEqual([a, b]);
      expect(unresolved).toHaveLength(0);
    });

    it('resolves a same-run entry against the issue just filed', () => {
      const b = finding({ title: 'second at the same line' });
      const { groups } = groupCommentsByIssue(
        [{ finding: b, issueNumber: null, sameRunFingerprint: fp }],
        (k: string) => (k === fp ? 900 : undefined)
      );
      expect(groups[0].issueNumber).toBe(900);
      expect(groups[0].fingerprint).toBe(fp);
    });

    it('reports — never silently drops — an entry whose issue was capped out', () => {
      const b = finding({ title: 'its issue never got filed' });
      const { groups, unresolved } = groupCommentsByIssue([
        { finding: b, issueNumber: null, sameRunFingerprint: fp },
      ]);
      expect(groups).toHaveLength(0);
      expect(unresolved).toHaveLength(1);
    });

    it('separates two issues into two comments', () => {
      const { groups } = groupCommentsByIssue([
        { finding: finding({ line: 1 }), issueNumber: 10 },
        { finding: finding({ line: 2 }), issueNumber: 20 },
      ]);
      expect(groups.map((g: { issueNumber: number }) => g.issueNumber)).toEqual([10, 20]);
    });

    it('round-trips: a run posts once, the next run finds it and posts nothing new', () => {
      // The end-to-end property the defect violated.
      const f = finding({ title: 'run one wording' });
      const { groups } = groupCommentsByIssue([{ finding: f, issueNumber: 4242 }]);
      const marker = locationCommentMarker({ fingerprint: groups[0].fingerprint, pr: '77' });
      const posted = [{ id: 88, body: `...body...\n${marker}` }];

      // Next push: same defect, reworded, new SHA — the case that repeated.
      const f2 = finding({ title: 'run two, entirely different wording' });
      const next = groupCommentsByIssue([{ finding: f2, issueNumber: 4242 }]);
      const marker2 = locationCommentMarker({ fingerprint: next.groups[0].fingerprint, pr: '77' });
      expect(marker2).toBe(marker);
      expect(findMarkedComment(posted, marker2)?.id, 'must edit #88, not post a second').toBe(88);
    });
  });

  it('fetchOpenFollowupTitles returns fingerprints keyed to issue numbers', async () => {
    // `fetchAllPages` expects a Response-shaped value, not a bare array.
    const gh = async () => ({
      ok: true,
      json: async () => [
        { number: 11, title: 'a', body: `x\n<!-- audit-fp:security|a.ts|1 -->` },
        { number: 12, title: 'b', body: 'no marker here' },
        { number: 13, title: 'c', body: `<!-- audit-fp:security|a.ts|1 -->` },
        { number: 99, title: 'pr', pull_request: { url: 'x' }, body: '<!-- audit-fp:x|y|1 -->' },
      ],
    });
    const { titles, fingerprints } = await fetchOpenFollowupTitles({ gh, owner: 'o', repo: 'r' });
    expect(titles.has('a')).toBe(true);
    expect(titles.has('pr')).toBe(false); // pull requests are not issues
    // First writer wins — comments go to the older issue. The legacy
    // three-part markers are read back under the current two-part key.
    expect(fingerprints.get('security|a.ts')).toBe(11);
    expect(fingerprints.has('x|y')).toBe(false); // the PR's marker is ignored
  });
});

describe('location comment body (issue 2206)', () => {
  const marker = '<!-- audit-cmt:reliability|a.ts|pr-1 -->';
  const base = { prUrl: 'https://x/pull/1', headSha: 'abcdef0123456789', marker };

  it('renders every finding, the footer and the marker last', () => {
    const body = buildLocationCommentBody({
      ...base,
      findings: [
        { severity: 'P2', title: 'one', detail: 'd1' },
        { severity: 'P2', title: 'two', detail: 'd2' },
      ],
    });
    expect(body).toContain('**P2** — one');
    expect(body).toContain('**P2** — two');
    expect(body).toContain('latest audit commit: abcdef01');
    expect(body.endsWith(marker)).toBe(true);
  });

  it("stays under GitHub's comment limit and KEEPS the upsert marker when the findings do not fit", () => {
    const huge = 'x'.repeat(40_000);
    const body = buildLocationCommentBody({
      ...base,
      findings: [
        { severity: 'P2', title: 'a', detail: huge },
        { severity: 'P2', title: 'b', detail: huge },
      ],
    });
    expect(body.length).toBeLessThanOrEqual(LOCATION_COMMENT_MAX_CHARS);
    expect(LOCATION_COMMENT_MAX_CHARS).toBeLessThan(65_536);
    // Without the marker the next run would POST a duplicate instead of editing.
    expect(body.endsWith(marker)).toBe(true);
    expect(body).toMatch(/truncated/);
  });

  it('audit.mjs checks both location-comment writes instead of logging success unconditionally', () => {
    const src = readFileSync(
      new URL('../../.github/scoped-audit/audit.mjs', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/const resp = prior\s*\?\s*await gh\('PATCH'/);
    expect(src).toMatch(/if \(!resp\.ok\)/);
    // No bare, unchecked awaited write to the comments endpoints remains.
    expect(src).not.toMatch(
      /^\s*await gh\('(PATCH|POST)', `\/repos\/\$\{owner\}\/\$\{repo\}\/issues\/(comments|\$\{group)/m
    );
  });
});
