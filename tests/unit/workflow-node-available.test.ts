/**
 * A workflow step that runs `node` must be in a job that installs it.
 *
 * WHAT THIS IS FOR
 *
 * On 2026-09-12 a step was added to `zap-baseline.yml` that runs
 * `node scripts/check-zap-review-dates.mjs`. That job has never had
 * `actions/setup-node`, and on the self-hosted runner `node` is not on the
 * Actions shell PATH. Result: `node: command not found`, exit 127 — and
 * because the step ran BEFORE the scan, the ZAP baseline DAST did not run at
 * all for two consecutive nights. A security scan was silently off, and the
 * only signal was a red workflow whose name made it read like a scan finding.
 *
 * The step's own comment reasoned about install COST ("No `npm ci`: the script
 * is dependency-free node") and never asked whether the runtime existed. That
 * is the failure this gate closes: the question is not "does this need
 * dependencies", it is "does this runner have node at all".
 *
 * This is a static check on workflow text, and it says so. It cannot prove a
 * step succeeds; it proves the runtime it invokes was asked for.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows');

/** Commands that need a Node toolchain on PATH. */
const NEEDS_NODE = /^\s*(?:-\s*)?(?:run:\s*)?.*\b(?:node|npm|npx|pnpm|yarn)\b/;

/**
 * Jobs allowed to invoke node without `setup-node`, with why.
 *
 * A container-based job that ships its own runtime is the legitimate case.
 * "It worked on my runner" is not — that is precisely the assumption that
 * turned the DAST off.
 */
const DELIBERATE: Record<string, string> = {};

interface Job {
  file: string;
  name: string;
  startLine: number;
  lines: string[];
}

/** Split each workflow into jobs, keyed by the `jobs:` child indentation. */
function jobs(): Job[] {
  if (!fs.existsSync(WORKFLOWS)) return [];
  return fs
    .readdirSync(WORKFLOWS)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap(file => {
      const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf-8').split('\n');
      const jobsIdx = lines.findIndex(l => /^jobs:\s*$/.test(l));
      if (jobsIdx === -1) return [];
      const starts: Array<{ name: string; line: number }> = [];
      for (let i = jobsIdx + 1; i < lines.length; i++) {
        const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
        if (m) starts.push({ name: m[1], line: i });
      }
      return starts.map((s, i) => ({
        file,
        name: s.name,
        startLine: s.line + 1,
        lines: lines.slice(s.line, i + 1 < starts.length ? starts[i + 1].line : lines.length),
      }));
    });
}

/** `run:` lines only — a `uses:` action brings its own runtime. */
function runLinesNeedingNode(job: Job): string[] {
  return job.lines.filter(l => {
    const isRun = /^\s+(?:-\s+)?run:\s*\S/.test(l) || /^\s{8,}\S/.test(l);
    if (!isRun) return false;
    if (/^\s*#/.test(l.trim())) return false;
    return NEEDS_NODE.test(l) && !/^\s*#/.test(l);
  });
}

function installsNode(job: Job): boolean {
  return job.lines.some(l => /uses:\s*actions\/setup-node@/.test(l));
}

function usesContainer(job: Job): boolean {
  return job.lines.some(l => /^\s{4}container:/.test(l) || /^\s{4}image:/.test(l));
}

describe('every job that runs node installs node', () => {
  it('no job invokes node/npm/npx without setup-node', () => {
    const offenders = jobs()
      .filter(j => runLinesNeedingNode(j).length > 0)
      .filter(j => !installsNode(j) && !usesContainer(j))
      .filter(j => !(`${j.file}:${j.name}` in DELIBERATE))
      .map(j => `${j.file}:${j.name} (line ${j.startLine})`);

    expect(
      offenders,
      'these jobs run node/npm/npx but never install a Node toolchain. On the self-hosted runner `node` is not on the Actions shell PATH, so the step dies with `command not found` (exit 127) — which is how the ZAP baseline DAST silently stopped running for two nights. Add `actions/setup-node`, or register the job in DELIBERATE with the reason its runtime is already present.'
    ).toEqual([]);
  });

  it('reads real jobs — the parser is not silently empty', () => {
    // Without this, a renamed directory or a broken job regex makes the
    // assertion above vacuous forever.
    const all = jobs();
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter(j => runLinesNeedingNode(j).length > 0).length).toBeGreaterThan(5);
  });

  it('zap-baseline installs node — it is the job that was broken', () => {
    // The positive control, naming the specific regression.
    const zap = jobs().filter(
      j => j.file === 'zap-baseline.yml' && runLinesNeedingNode(j).length > 0
    );
    expect(zap.length).toBeGreaterThan(0);
    for (const j of zap) {
      expect(installsNode(j), `${j.file}:${j.name} runs node without setup-node`).toBe(true);
    }
  });
});
