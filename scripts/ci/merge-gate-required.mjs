#!/usr/bin/env node
// Prints (JSON array) the check names scripts/ci/merge-gate.sh requires to be an explicit SUCCESS, DERIVED from
// .github/workflows/*.yml so the list cannot drift from the workflows:
//   a job is required when its workflow runs on pull_request AND the job always runs on a PR, i.e. it has no job-level
//   `if`, or its `if` is exactly `github.event_name == 'pull_request'`, and everything it `needs` is itself such a job.
// Conditional jobs (lint, unit, worker dry-runs ... gated on the affected-workspace outputs) may legitimately be
// SKIPPED and are checked for "completed and not failing" instead. Jobs whose name is a matrix expression are skipped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALWAYS_IF = /^github\.event_name == 'pull_request'$/;

export function parseWorkflow(text) {
  const lines = text.split('\n');
  const onPr = (() => {
    const i = lines.findIndex(l => /^on:\s*$/.test(l));
    if (i < 0) return /^on:.*pull_request/m.test(text);
    for (let j = i + 1; j < lines.length && /^(\s|$)/.test(lines[j]); j++) if (/^\s+pull_request\s*:/.test(lines[j])) return true;
    return false;
  })();
  const jobs = {};
  let inJobs = false;
  let cur = null;
  for (const raw of lines) {
    if (/^jobs:\s*$/.test(raw)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(raw) && raw.trim() !== '') { inJobs = false; cur = null; }
    if (!inJobs) continue;
    let m = raw.match(/^  ([\w-]+):\s*$/);
    if (m) { cur = jobs[m[1]] = { id: m[1], name: null, if: null, needs: [] }; continue; }
    if (!cur) continue;
    if ((m = raw.match(/^    name:\s*(.+?)\s*$/))) cur.name = m[1].replace(/^['"]|['"]$/g, '');
    else if ((m = raw.match(/^    if:\s*(.+?)\s*$/))) cur.if = m[1];
    else if ((m = raw.match(/^    needs:\s*(.+?)\s*$/))) cur.needs = m[1].replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return { onPr, jobs };
}

export function requiredChecks(dir) {
  const out = new Set();
  for (const f of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    const { onPr, jobs } = parseWorkflow(readFileSync(join(dir, f), 'utf8'));
    if (!onPr) continue;
    const always = id => {
      const j = jobs[id];
      if (!j) return false;
      if (j.if !== null && !ALWAYS_IF.test(j.if)) return false;
      return j.needs.every(always);
    };
    for (const j of Object.values(jobs)) if (always(j.id)) {
      const name = j.name ?? j.id;
      if (!name.includes('${{')) out.add(name);
    }
  }
  return [...out].sort();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(JSON.stringify(requiredChecks(process.argv[2] ?? '.github/workflows')));
}
