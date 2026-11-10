/**
 * A very large diff (scripts/scoped-audit.sh caps it at ~150KB, roughly the
 * ~12k-line diffs this was observed against) can make the model's own JSON
 * response run long enough to be cut off mid-generation. Before this, that
 * response failed `JSON.parse` outright and the gate reported "DID NOT RUN" —
 * dropping every finding the model actually wrote down before running out of
 * room, on exactly the largest, riskiest PRs. `recoverTruncatedFindings`
 * salvages the complete finding objects instead of losing all of them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
// @ts-expect-error - plain .mjs script, no types
import { recoverTruncatedFindings } from '../../.github/scoped-audit/partial-json.mjs';
import {
  auditExitCode,
  auditVerdict,
  nonRunExitCode,
  // @ts-expect-error - plain .mjs script, no types
} from '../../.github/scoped-audit/gate-policy.mjs';

describe('recoverTruncatedFindings', () => {
  it('recovers nothing from a response with no findings array at all', () => {
    expect(recoverTruncatedFindings('not json')).toBeNull();
    expect(recoverTruncatedFindings('{"summary":"clean"}')).toBeNull();
    expect(recoverTruncatedFindings(undefined as unknown as string)).toBeNull();
  });

  it('recovers every complete finding when the array is cut mid-object', () => {
    // A realistic truncation: two complete findings, then a third cut off
    // partway through its "detail" string — no closing brace, no closing `]`.
    const truncated =
      '{"summary":"large diff","findings":[' +
      '{"severity":"P0","dimension":"security","file":"a.ts","line":1,"title":"t1","detail":"d1","fix":"f1","blastRadius":"b1"},' +
      '{"severity":"P1","dimension":"rls","file":"b.ts","line":2,"title":"t2","detail":"d2","fix":"f2","blastRadius":"b2"},' +
      '{"severity":"P2","dimension":"reliability","file":"c.ts","line":3,"title":"t3","detail":"the model was still writing this str';

    const r = recoverTruncatedFindings(truncated);
    expect(r).not.toBeNull();
    expect(r.truncated).toBe(true);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].title).toBe('t1');
    expect(r.findings[1].title).toBe('t2');
  });

  it('recovers findings even when cut off before any object starts', () => {
    const truncated = '{"summary":"large diff","findings":[';
    expect(recoverTruncatedFindings(truncated)).toBeNull();
  });

  it('returns null for a genuinely clean, complete-but-differently-broken envelope', () => {
    // Balanced JSON that is simply not the expected shape — nothing to recover.
    expect(recoverTruncatedFindings('{"summary":"ok","result":"not findings"}')).toBeNull();
  });

  it('handles braces and commas inside string values without losing its place', () => {
    const truncated =
      '{"findings":[' +
      '{"severity":"P0","dimension":"security","file":"a.ts","line":1,"title":"t1",' +
      '"detail":"has a { brace }, and a comma, inside the string","fix":"f1","blastRadius":"b1"},' +
      '{"severity":"P1","dimension":"rls","file":"b.ts","line":2,"title":"cut off partway';
    const r = recoverTruncatedFindings(truncated);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].detail).toContain('{ brace }, and a comma,');
  });

  it('recovers everything when the array actually closed cleanly', () => {
    // Not a truncation case at all — JSON.parse would have succeeded on the
    // full envelope, but the recovery path must not choke if it is ever
    // reached on well-formed input (e.g. trailing prose after the object).
    const clean =
      '{"findings":[{"severity":"P3","dimension":"docs-parity","file":"x.ts","line":1,"title":"t","detail":"d","fix":"f","blastRadius":"b"}]} trailing prose';
    const r = recoverTruncatedFindings(clean);
    expect(r.findings).toHaveLength(1);
  });
});

// Scoped audit, PR 1978: recovery fed a truncated response into the normal
// path, so a review that never reached the end of the diff rendered
// "Scoped Audit — PASSED" and exited 0 — a green tick on the largest PRs.
describe('a PARTIAL (truncated) audit is never reported as PASSED', () => {
  it('partial + no blocking finding → PARTIAL, and the non-run exit (red, not 0)', () => {
    expect(auditVerdict({ blockingFindings: 0, partial: true })).toBe('PARTIAL');
    expect(auditExitCode({ blockingFindings: 0, partial: true })).toBe(nonRunExitCode());
    expect(auditExitCode({ blockingFindings: 0, partial: true })).not.toBe(0);
  });

  it('partial + a recovered P0/P1 still BLOCKS with exit 1', () => {
    expect(auditVerdict({ blockingFindings: 2, partial: true })).toBe('BLOCKED');
    expect(auditExitCode({ blockingFindings: 2, partial: true })).toBe(1);
  });

  it('a complete audit is unchanged: PASSED/0 when clean, BLOCKED/1 when not', () => {
    expect(auditVerdict({ blockingFindings: 0 })).toBe('PASSED');
    expect(auditExitCode({ blockingFindings: 0 })).toBe(0);
    expect(auditVerdict({ blockingFindings: 1 })).toBe('BLOCKED');
    expect(auditExitCode({ blockingFindings: 1 })).toBe(1);
  });

  // Behaviour, not source text: audit.mjs is a top-level script, so it is RUN as a child process
  // against a recorded model response, with `fetch` replaced by an in-memory GitHub (a preload
  // module). What is asserted is what a merge decision reads: the exit code and the verdict line
  // the script writes to its step summary.
  describe('audit.mjs end to end (child process, GitHub faked)', () => {
    const AUDIT = fileURLToPath(new URL('../../.github/scoped-audit/audit.mjs', import.meta.url));
    const dir = mkdtempSync(path.join(tmpdir(), 'scoped-audit-'));
    const preload = path.join(dir, 'fake-github.mjs');
    writeFileSync(
      preload,
      `globalThis.fetch = async (_url, init = {}) => {
         const list = (init.method ?? 'GET') === 'GET';
         const body = list ? [] : { id: 1, number: 1, html_url: 'https://example.test/1' };
         return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
       };`
    );
    const finding = (severity: string, n: number) =>
      `{"severity":"${severity}","dimension":"security","file":"a.ts","line":${n},"title":"t${n}","detail":"d","fix":"f","blastRadius":"b"}`;

    function runAudit(modelText: string) {
      const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
      const summary = path.join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
      writeFileSync(out, JSON.stringify({ result: modelText }));
      writeFileSync(summary, '');
      const r = spawnSync(process.execPath, ['--import', preload, AUDIT], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          GITHUB_TOKEN: 'x',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_EVENT_NAME: 'pull_request',
          PR_NUMBER: '1',
          HEAD_SHA: 'abcdef0123456789',
          CLAUDE_OUTPUT: out,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      return { code: r.status, summary: readFileSync(summary, 'utf8') };
    }

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('control: a complete, clean audit passes with exit 0', () => {
      const r = runAudit('{"summary":"ok","findings":[]}');
      expect(r.summary).toContain('Scoped Audit — PASSED');
      expect(r.code).toBe(0);
    });

    it('a truncated response with nothing blocking is PARTIAL and exits red, never PASSED/0', () => {
      const r = runAudit(
        `{"summary":"big","findings":[${finding('P3', 1)},{"severity":"P2","dimen`
      );
      expect(r.summary).toContain('Scoped Audit — PARTIAL');
      expect(r.summary).not.toContain('PASSED');
      expect(r.code).toBe(nonRunExitCode());
      expect(r.code).not.toBe(0);
    });

    it('a truncated response with a recovered P0 still BLOCKS with exit 1', () => {
      const r = runAudit(
        `{"summary":"big","findings":[${finding('P0', 1)},{"severity":"P2","dimen`
      );
      expect(r.summary).toContain('Scoped Audit — BLOCKED');
      expect(r.code).toBe(1);
    });
  });
});
