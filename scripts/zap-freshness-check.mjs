#!/usr/bin/env node
/**
 * ZAP DAST freshness check (issue 2289).
 *
 * zap-baseline.yml's `notify-failure` job alerts on a failed or cancelled scan
 * — but only if that job itself gets dispatched and gets a runner. A whole run
 * cancelled while still queued (the concurrency group superseding a starved
 * nightly), or one that never gets a runner at all, can end with notify-failure
 * never executing: silence that reads like a clean night. A job inside the run
 * cannot report the run not happening, so this check lives OUTSIDE it, in its
 * own scheduled workflow: it asks the API whether any zap-baseline run on main
 * CONCLUDED `success` or `failure` (a scan that actually ran) within the window,
 * and exits 1 when none did.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), ZAP_TARGET (unset = the
 * scan is dormant by design, exit 0), WINDOW_HOURS (default 26: one nightly
 * cadence plus queue slack).
 *
 * Exit 0 = a scan ran in the window (or the scan is dormant), 1 = stale,
 * 2 = the API could not be read (fail closed — unknown is not fresh).
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_WINDOW_HOURS = 26;
const RAN = new Set(['success', 'failure']);

/**
 * Pure verdict over the runs list (GitHub REST `workflow_runs` shape).
 * @returns {{ ok: boolean, reason: string }}
 */
export function assessZapFreshness(runs, nowMs, windowHours = DEFAULT_WINDOW_HOURS) {
  const since = nowMs - windowHours * 3600_000;
  const recent = runs.filter(r => Date.parse(r.created_at) >= since);
  const ran = recent.find(r => r.status === 'completed' && RAN.has(r.conclusion));
  if (ran) {
    return {
      ok: true,
      reason: `run ${ran.id} (${ran.event}) concluded ${ran.conclusion} at ${ran.updated_at ?? ran.created_at}`,
    };
  }
  if (recent.length === 0) {
    return {
      ok: false,
      reason: `no zap-baseline run on main was even created in the last ${windowHours}h — the schedule did not fire or the workflow is disabled`,
    };
  }
  const seen = recent
    .map(r => `${r.id}: ${r.status}${r.conclusion ? `/${r.conclusion}` : ''}`)
    .join(', ');
  return {
    ok: false,
    reason: `no zap-baseline run in the last ${windowHours}h actually scanned (${seen}) — cancelled, timed out waiting for a runner, or still queued`,
  };
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, ZAP_TARGET } = process.env;
  const windowHours = Number(process.env.WINDOW_HOURS || DEFAULT_WINDOW_HOURS);
  if (!ZAP_TARGET) {
    console.log(
      'zap-freshness: ZAP_TARGET is unset — the DAST is dormant by design, nothing to check'
    );
    return 0;
  }
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.error('zap-freshness: GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    return 2;
  }
  const url =
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/zap-baseline.yml/runs` +
    `?branch=main&per_page=30`;
  let body;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    console.error(
      `zap-freshness: cannot list zap-baseline runs — ${err.message}. Unknown, not fresh.`
    );
    return 2;
  }
  const verdict = assessZapFreshness(body.workflow_runs ?? [], Date.now(), windowHours);
  (verdict.ok ? console.log : console.error)(
    `zap-freshness: ${verdict.ok ? 'fresh' : 'STALE'} — ${verdict.reason}`
  );
  return verdict.ok ? 0 : 1;
}

/** Exit code → the state the workflow's alert step branches on. */
export const STATE_BY_EXIT = { 0: 'fresh', 1: 'stale', 2: 'unknown' };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => {
    // A token/API failure must not page as "no scan ran" (PR 2333 audit P3).
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, `state=${STATE_BY_EXIT[code] ?? 'unknown'}\n`);
      } catch {
        /* the alert step treats a missing state as unknown */
      }
    }
    process.exit(code);
  });
}
