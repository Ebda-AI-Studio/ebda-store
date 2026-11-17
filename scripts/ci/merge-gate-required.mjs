#!/usr/bin/env node
// Prints (JSON array) the check names scripts/ci/merge-gate.sh requires to be an explicit SUCCESS, DERIVED from
// .github/workflows/*.yml so the list cannot drift from the workflows:
//   a job is required when its workflow runs on pull_request AND the job always runs on a PR, i.e. it has no job-level
//   `if`, or its `if` is exactly `github.event_name == 'pull_request'`, and everything it `needs` is itself such a job.
// Conditional jobs (lint, unit, worker dry-runs ... gated on the affected-workspace outputs) may legitimately be
// SKIPPED and are checked for "completed and not failing" instead. Jobs whose name is a matrix expression are skipped.
// A workflow whose pull_request trigger is filtered by `paths` / `paths-ignore` does not run on every PR (GitHub creates
// no check at all for a PR outside the filter), so none of its jobs is required: requiring one makes the gate wait its
// whole budget on a check that will never report (a docs-only PR against blast-radius.yml, 2026-11-09).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALWAYS_IF = /^github\.event_name == 'pull_request'$/;
// An aggregator that runs even when the jobs it needs were (legitimately) skipped: always required on a PR. It may skip a
// CANCELLED run (`&& !cancelled()`): a superseded run's aggregators would otherwise wait for a scarce Mac runner slot.
// MERGE-QUEUE-1 part B: `needs.tested-tree.outputs.skip != 'true'` gates the full-lane root jobs on a PUSH to main only. The `tested-tree` job answers
// skip=false at once on every other event (scripts/ci/tested-tree.mjs), so on a pull request such a job always runs: it counts as always-on there.
const TESTED_TREE_IF = /^needs\.tested-tree\.outputs\.skip != 'true'$/;
const ALWAYS_RUN_IF = /^always\(\) (&& !cancelled\(\) )?&& github\.event_name == 'pull_request'$/;

export function parseWorkflow(text) {
  const lines = text.split('\n');
  const onPr = (() => {
    const i = lines.findIndex(l => /^on:\s*$/.test(l));
    if (i < 0) return /^on:.*pull_request/m.test(text);
    for (let j = i + 1; j < lines.length && /^(\s|$)/.test(lines[j]); j++)
      if (/^\s+pull_request\s*:/.test(lines[j])) return true;
    return false;
  })();
  // Path filters nested under the pull_request trigger only: a filter on push / schedule says nothing about PRs.
  const prPathFiltered = (() => {
    if (/^on:.*pull_request\s*:\s*\{[^}]*\bpaths(-ignore)?\s*:/m.test(text)) return true;
    const i = lines.findIndex(l => /^\s+pull_request\s*:/.test(l));
    if (i < 0) return false;
    if (/\bpaths(-ignore)?\s*:/.test(lines[i])) return true;
    const indent = lines[i].match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      if (/^\s+paths(-ignore)?\s*:/.test(lines[j])) return true;
    }
    return false;
  })();
  const jobs = {};
  let inJobs = false;
  let cur = null;
  for (const raw of lines) {
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(raw) && raw.trim() !== '') {
      inJobs = false;
      cur = null;
    }
    if (!inJobs) continue;
    let m = raw.match(/^  ([\w-]+):\s*$/);
    if (m) {
      cur = jobs[m[1]] = { id: m[1], name: null, if: null, needs: [] };
      continue;
    }
    if (!cur) continue;
    if ((m = raw.match(/^    name:\s*(.+?)\s*$/))) cur.name = m[1].replace(/^['"]|['"]$/g, '');
    else if ((m = raw.match(/^    if:\s*(.+?)\s*$/))) cur.if = m[1];
    else if ((m = raw.match(/^    needs:\s*(.+?)\s*$/)))
      cur.needs = m[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
  }
  return { onPr, prPathFiltered, jobs };
}

export function requiredChecks(dir) {
  const out = new Set();
  for (const f of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    const { onPr, prPathFiltered, jobs } = parseWorkflow(readFileSync(join(dir, f), 'utf8'));
    if (!onPr || prPathFiltered) continue;
    const always = id => {
      const j = jobs[id];
      if (!j) return false;
      if (j.if !== null && ALWAYS_RUN_IF.test(j.if)) return true;
      if (j.if !== null && !ALWAYS_IF.test(j.if) && !TESTED_TREE_IF.test(j.if)) return false;
      return j.needs.every(always);
    };
    for (const j of Object.values(jobs))
      if (always(j.id)) {
        const name = j.name ?? j.id;
        if (!name.includes('${{')) out.add(name);
      }
  }
  return [...out].sort();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(JSON.stringify(requiredChecks(process.argv[2] ?? '.github/workflows')));
}
