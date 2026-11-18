/**
 * The dependency-audit gate's verdict.
 *
 * `Security Audit` is one of the eleven REQUIRED checks, and it used to read
 * `report.vulnerabilities ?? {}` — so when npm could not reach the advisory
 * endpoint it emitted an error envelope with no vulnerabilities map, the loop
 * ran zero times, and the gate printed "clean" and exited 0. Reproduced live on
 * 2026-09-04 against a 503ing registry.
 *
 * A report without a vulnerabilities map is not a clean report. It is not a
 * report.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error - plain .mjs script, no types
import {
  classifyAuditReport,
  auditExitCode,
  AUDIT,
} from '../../.github/scripts/audit-report-verdict.mjs';

const advisory = (id: string, severity = 'high') => ({
  via: [{ url: `https://github.com/advisories/${id}`, severity, title: 'something' }],
});

describe('an audit that did not happen is not a clean audit', () => {
  it('rejects npm error envelope', () => {
    const r = classifyAuditReport({ error: { code: 'ENETUNREACH', summary: 'endpoint error' } });
    expect(r.verdict).toBe(AUDIT.UNUSABLE);
    expect(auditExitCode(r.verdict), 'this used to exit 0 and pass a required check').toBe(1);
  });

  it('rejects output with no vulnerabilities map at all', () => {
    const r = classifyAuditReport({ metadata: {} });
    expect(r.verdict).toBe(AUDIT.UNUSABLE);
    expect(auditExitCode(r.verdict)).toBe(1);
  });

  it('rejects a non-object payload', () => {
    expect(classifyAuditReport(null).verdict).toBe(AUDIT.UNUSABLE);
    expect(classifyAuditReport('nope').verdict).toBe(AUDIT.UNUSABLE);
  });

  it('states a reason a human can act on', () => {
    expect(classifyAuditReport({ error: { summary: 'endpoint error' } }).reason).toMatch(
      /endpoint error/
    );
  });
});

describe('a genuinely empty report is clean', () => {
  it('an empty map means nothing is wrong', () => {
    const r = classifyAuditReport({ vulnerabilities: {} });
    expect(r.verdict).toBe(AUDIT.CLEAN);
    expect(auditExitCode(r.verdict)).toBe(0);
  });
});

describe('findings', () => {
  it('blocks on an unwaived advisory', () => {
    const r = classifyAuditReport({ vulnerabilities: { lodash: advisory('GHSA-1') } });
    expect(r.verdict).toBe(AUDIT.BLOCKING);
    expect(auditExitCode(r.verdict)).toBe(1);
    expect(r.blocking[0]).toContain('lodash');
  });

  it('waives a documented advisory and stays clean', () => {
    const allow = new Map([['GHSA-1', 'no upstream fix']]);
    const r = classifyAuditReport({ vulnerabilities: { lodash: advisory('GHSA-1') } }, allow);
    expect(r.verdict).toBe(AUDIT.CLEAN);
    expect(r.waived).toHaveLength(1);
  });

  it('a waiver does not hide an unrelated advisory', () => {
    const allow = new Map([['GHSA-1', 'no upstream fix']]);
    const r = classifyAuditReport(
      { vulnerabilities: { lodash: advisory('GHSA-1'), axios: advisory('GHSA-2') } },
      allow
    );
    expect(r.verdict).toBe(AUDIT.BLOCKING);
    expect(r.blocking.join(' ')).toContain('axios');
    expect(r.blocking.join(' ')).not.toContain('lodash');
  });

  it('survives a malformed entry without crashing the gate', () => {
    const r = classifyAuditReport({ vulnerabilities: { weird: {}, other: { via: ['string'] } } });
    expect(r.verdict).toBe(AUDIT.CLEAN);
  });
});

describe('the retry budget fits inside the job budget', () => {
  // Adding retry without bounding each attempt moved the failure rather than
  // fixing it: three unbounded `npm audit` calls against a slow registry ran
  // the step to 7m46s against `timeout-minutes: 7`, so the job was CANCELLED.
  // A cancelled required check is neither pass nor fail — it blocks the merge
  // and offers no finding to act on, which is worse than either outcome.
  //
  // The relationship is asserted rather than commented, because a comment does
  // not fail when someone raises ATTEMPTS.
  const gate = readFileSync(
    new URL('../../.github/scripts/audit-gate.mjs', import.meta.url),
    'utf8'
  );
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

  const num = (re: RegExp, src: string, label: string) => {
    const m = src.match(re);
    expect(m, `could not read ${label} — the shape changed`).toBeTruthy();
    return Number(m![1].replace(/_/g, ''));
  };

  // Measured, not guessed. A cold `npm ci` on a slow runner is 268s (measured; see
  // the Security Audit timeout in ci.yml); warm runs are 21-64s.
  // checkout + setup-node + jq + trufflehog measured 3-22s across 30 recent
  // Security Audit runs — 120s allows the occasional slow scan.
  const COLD_INSTALL_S = 268;
  const OTHER_STEPS_S = 120;

  it('worst-case retry time PLUS a cold install fits the Security Audit job timeout', () => {
    // Scoped audit, PR 1978: this used to check the attempt arithmetic alone
    // (worst case < 60% of the budget). 110s attempts passed that at 10 min
    // while a cold install pushed the real need to ~10.5 min — a CANCELLED
    // required check on exactly the slow-registry day the retry is for.
    const attempts = num(/const ATTEMPTS = (\d+)/, gate, 'ATTEMPTS');
    const perAttemptMs = num(/const ATTEMPT_TIMEOUT_MS = ([\d_]+)/, gate, 'ATTEMPT_TIMEOUT_MS');
    const maxBackoffS = num(/Math\.min\(attempt \* \d+, (\d+)\)/, gate, 'backoff cap');

    // Job timeout for the Security Audit job specifically — the first
    // timeout-minutes AFTER its name, within its own job block.
    const start = ci.indexOf('name: Security Audit');
    expect(start, 'Security Audit job not found').toBeGreaterThan(-1);
    const jobBlock = ci.slice(start, ci.indexOf('\n    steps:', start));
    const jobTimeoutMin = num(/timeout-minutes: (\d+)/, jobBlock, 'Security Audit timeout-minutes');

    const auditWorstS = attempts * (perAttemptMs / 1000) + (attempts - 1) * maxBackoffS;
    // two bounded audit runs: the blocking production gate and the non-blocking all-dependencies report (Ruling AUDIT-SPLIT-1)
    const needS = 2 * auditWorstS + COLD_INSTALL_S + OTHER_STEPS_S;
    const budgetS = jobTimeoutMin * 60;

    expect(
      needS,
      `2 x audit ${auditWorstS}s + cold install ${COLD_INSTALL_S}s + other steps ${OTHER_STEPS_S}s = ` +
        `${needS}s must fit the ${budgetS}s job budget`
    ).toBeLessThan(budgetS);
  });

  it('each attempt is bounded, not just the loop', () => {
    // An unbounded attempt makes the worst case unknowable regardless of count.
    expect(gate, 'execFileSync must carry a timeout').toMatch(/timeout: ATTEMPT_TIMEOUT_MS/);
    expect(gate, 'npm needs its own fetch timeout too').toMatch(/--fetch-timeout=/);
  });

  it('#1520: the exhausted-retries message is distinct from a real advisory', () => {
    // An operator reading the log must be able to tell "the registry was slow"
    // from "npm audit found something" without opening the run.
    expect(gate).toMatch(/could not reach the advisory endpoint/);
    expect(gate).toMatch(/not a vulnerability finding/);
  });
});
