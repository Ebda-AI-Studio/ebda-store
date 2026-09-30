/**
 * Issue 2289: notify-failure inside zap-baseline.yml cannot report a run that
 * was cancelled before it was dispatched, or never got a runner. The
 * out-of-run check (scripts/zap-freshness-check.mjs, run by
 * zap-freshness-check.yml) asks whether a scan ACTUALLY RAN in the window.
 * These tests drive the verdict with run lists shaped like the real history
 * (e.g. 35572954211: "exceeded the maximum execution time while awaiting a
 * runner for 24h0m0s" → conclusion cancelled).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
// @ts-expect-error — plain .mjs script, no type declarations
import { assessZapFreshness } from '../../scripts/zap-freshness-check.mjs';

const NOW = Date.parse('2026-10-01T12:30:00Z');
const run = (id: number, hoursAgo: number, status: string, conclusion: string | null) => ({
  id,
  event: 'schedule',
  status,
  conclusion,
  created_at: new Date(NOW - hoursAgo * 3600_000).toISOString(),
});

describe('assessZapFreshness', () => {
  it('fresh when a scan concluded success in the window', () => {
    expect(assessZapFreshness([run(1, 10, 'completed', 'success')], NOW).ok).toBe(true);
  });

  it('fresh when a scan concluded failure (it RAN; notify-failure owns that alert)', () => {
    expect(assessZapFreshness([run(1, 10, 'completed', 'failure')], NOW).ok).toBe(true);
  });

  it('STALE when the only run in the window was cancelled — the case notify-failure cannot see', () => {
    const v = assessZapFreshness([run(2, 10, 'completed', 'cancelled')], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/2: completed\/cancelled/);
  });

  it('STALE when the run is still queued (starved runner)', () => {
    expect(assessZapFreshness([run(3, 10, 'queued', null)], NOW).ok).toBe(false);
  });

  it('STALE when no run was created at all (schedule disabled / did not fire)', () => {
    const v = assessZapFreshness([run(4, 50, 'completed', 'success')], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/was even created/);
  });

  it('a success OUTSIDE the window does not rescue a cancelled night inside it', () => {
    const v = assessZapFreshness(
      [run(5, 5, 'completed', 'cancelled'), run(6, 30, 'completed', 'success')],
      NOW
    );
    expect(v.ok).toBe(false);
  });
});

describe('zap-freshness-check.mjs CLI', () => {
  const SCRIPT = path.resolve(__dirname, '../../scripts/zap-freshness-check.mjs');
  const env = (extra: Record<string, string>) => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    delete e.GITHUB_TOKEN;
    delete e.ZAP_TARGET;
    return { ...e, ...extra };
  };

  it('exits 0 as dormant when ZAP_TARGET is unset (the scan itself is dormant then)', () => {
    const r = spawnSync('node', [SCRIPT], { env: env({}), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/dormant/);
  });

  it('writes state=unknown to GITHUB_OUTPUT on an unreadable API, so the alert does not claim "no scan"', () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'zapf-')), 'out');
    writeFileSync(out, '');
    const r = spawnSync('node', [SCRIPT], {
      env: env({ ZAP_TARGET: 'https://x.invalid', GITHUB_OUTPUT: out }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(readFileSync(out, 'utf8')).toBe('state=unknown\n');
  });

  it('fails CLOSED (2) without credentials — unknown is not fresh', () => {
    const r = spawnSync('node', [SCRIPT], {
      env: env({ ZAP_TARGET: 'https://x.invalid' }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
  });
});

describe('workflow wiring', () => {
  const root = path.resolve(__dirname, '../..');
  const wf = yaml.load(
    readFileSync(path.join(root, '.github/workflows/zap-freshness-check.yml'), 'utf8')
  ) as {
    on: { schedule?: Array<{ cron: string }> };
    permissions: Record<string, string>;
    jobs: Record<
      string,
      { steps: Array<{ run?: string; if?: string; env?: Record<string, string> }> }
    >;
  };

  it('is scheduled, reads Actions, runs the script, and alerts on failure', () => {
    expect(wf.on.schedule?.length).toBeGreaterThan(0);
    expect(wf.permissions.actions).toBe('read');
    const steps = wf.jobs.check.steps;
    const check = steps.find(s => s.run?.includes('node scripts/zap-freshness-check.mjs'));
    expect(check?.env?.ZAP_TARGET).toBe('${{ vars.ZAP_TARGET }}');
    const alert = steps.find(s => /cancelled\(\)/.test(s.if ?? ''));
    expect(alert?.if).toBe('always() && (failure() || cancelled())');
    expect(alert?.run).toMatch(/api\.telegram\.org/);
    expect(alert?.env?.STATE).toBe('${{ steps.fresh.outputs.state }}');
    expect(alert?.run).toMatch(/if \[ "\$STATE" = "stale" \]/);
  });

  it('a manual dispatch cannot cancel the scheduled watchdog (concurrency keyed on the event)', () => {
    const raw = readFileSync(path.join(root, '.github/workflows/zap-freshness-check.yml'), 'utf8');
    const doc = yaml.load(raw) as { concurrency: { group: string } };
    expect(doc.concurrency.group).toMatch(/github\.event_name/);
  });

  it('zap-baseline.yml and the triage doc no longer claim a cancelled run always alerts', () => {
    const zap = readFileSync(path.join(root, '.github/workflows/zap-baseline.yml'), 'utf8');
    const doc = readFileSync(path.join(root, 'docs/security/zap-triage-2026-07-15.md'), 'utf8');
    expect(zap).toMatch(/zap-freshness-check\.yml/);
    expect(doc).toMatch(/zap-freshness-check\.yml/);
    expect(doc).not.toMatch(/it alerts, it is not an expected outcome/);
  });
});
