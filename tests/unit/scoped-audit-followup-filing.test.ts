/**
 * The scoped-audit gate's issue-filing policy.
 *
 * Both cases below are the two defects that let the followup backlog reach 703
 * open issues, 241 of them filed in the two days the audit spent reviewing the
 * pull requests that were fixing its own earlier findings.
 */

import { describe, it, expect } from 'vitest';
import {
  fetchOpenFollowupTitles,
  followupIssueTitle,
  selectFollowupsToFile,
  // @ts-expect-error - plain .mjs script, no types
} from '../../.github/scoped-audit/followup-filing.mjs';
// @ts-expect-error - plain .mjs script, no types
import { fetchAllPages } from '../../.github/scoped-audit/gh-paginate.mjs';
// @ts-expect-error - plain .mjs script, no types
import { resolveMarkerComment } from '../../.github/scoped-audit/marker-comment.mjs';

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
