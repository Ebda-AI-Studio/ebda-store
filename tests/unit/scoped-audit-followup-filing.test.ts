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

describe('every path that admits it did not audit must exit non-zero', () => {
  // Three of these were fixed and a FOURTH was missed, which the gate itself
  // caught on the next run. Then THREE MORE were found — the pre-flight guards
  // — which this test could not see at all, because it keyed on the name of the
  // alert function and those paths did not alert. A test that certifies an
  // invariant it cannot observe is worse than no test.
  //
  // So it no longer looks for a function name. It looks at every zero-exit in
  // the file and asserts that only ONE exists: the terminal success. Any new
  // early return has to justify itself here.
  const source = readFileSync(
    new URL('../../.github/scoped-audit/audit.mjs', import.meta.url),
    'utf8'
  );
  const lines = source.split('\n');

  const zeroExits = lines
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /process\.exit\(\s*0\s*\)/.test(line));

  it('has exactly one exit-zero, and it is the terminal success', () => {
    expect(
      zeroExits.length,
      `exit(0) at lines ${zeroExits.map(z => z.n).join(', ')} — every early exit must use nonRunExitCode()`
    ).toBe(1);
    // The terminal one is the last statement in the file, not an early return.
    const remaining = lines.slice(zeroExits[0].n).filter(l => l.trim().length > 0);
    expect(remaining, 'the one exit(0) is not the final statement').toHaveLength(0);
  });

  it('no exit sits under a line admitting it skipped', () => {
    // Catches the shape regardless of how the skip is worded or reported.
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

  it('separates two different files, and two different lines in one file', () => {
    expect(followupFingerprint(finding())).not.toBe(
      followupFingerprint(finding({ file: 'apps/api/src/services/cart.service.ts' }))
    );
    expect(followupFingerprint(finding())).not.toBe(followupFingerprint(finding({ line: 900 })));
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
    // First writer wins — comments go to the older issue.
    expect(fingerprints.get('security|a.ts|1')).toBe(11);
    expect(fingerprints.has('x|y|1')).toBe(false); // the PR's marker is ignored
  });
});
