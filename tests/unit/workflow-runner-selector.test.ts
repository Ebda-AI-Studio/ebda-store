/**
 * Every workflow job honours the `USE_SELF_HOSTED` kill switch.
 *
 * WHY THIS EXISTS
 *
 * `vars.USE_SELF_HOSTED=false` is the documented escape hatch for a
 * self-hosted runner that is drained, offline or wedged
 * (`docs/runbooks/wsl-runner-maintenance.md`). It only works if every job's
 * `runs-on` actually consults it.
 *
 * `gitleaks.yml`'s `notify-failure` was hardcoded to
 * `[self-hosted, linux, wsl2]` — the only such pin in the repo. The reasoning
 * was sound on its own terms: with the org billing block, a GitHub-hosted job
 * dies in ~3s with no runner assigned, so an alerting job on cloud reports
 * nothing and silence reads as green. But it traded one silence for another.
 *
 * **GitHub does not FAIL a job whose labels match no online runner — it
 * QUEUES it**, for up to ~24h, and `timeout-minutes` only starts counting once
 * a runner is assigned. So in exactly the incident the runbook is written for,
 * the secret-leak alert never sends and the run sits "in progress" all day.
 * Reported twice (#1635, #1616), once as a reliability defect and once as
 * documentation drift, which is what two reports of one root cause look like.
 *
 * WHAT THIS ASSERTS
 *
 * Each `runs-on:` in `.github/workflows` is one of the sanctioned forms, or is
 * registered below with a reason. A new workflow pinning a label set fails
 * this until someone writes down why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows');

/**
 * The two sanctioned spellings. Both honour `vars.USE_SELF_HOSTED`; the longer
 * one also lets a `workflow_dispatch` force cloud for a single run without
 * touching the variable.
 */
const SANCTIONED = [
  '${{ (inputs.force_cloud || vars.USE_SELF_HOSTED != \'true\') && \'ubuntu-latest\' || fromJSON(\'["self-hosted","linux","wsl2"]\') }}',
  '${{ vars.USE_SELF_HOSTED != \'true\' && \'ubuntu-latest\' || fromJSON(\'["self-hosted","linux","wsl2"]\') }}',
  "${{ vars.USE_SELF_HOSTED == 'true' && 'self-hosted' || 'ubuntu-latest' }}",
];

/**
 * Jobs deliberately pinned, with why.
 *
 * `ubuntu-latest` is allowed unconditionally: a cloud-pinned job is never
 * made UNREACHABLE by the kill switch, which is the failure this gate exists
 * to prevent. It may be billing-blocked, which is a different problem with a
 * different signal.
 */
const DELIBERATE: Record<string, string> = {};

function workflowFiles(): string[] {
  if (!fs.existsSync(WORKFLOWS)) return [];
  return fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
}

/** Every `runs-on:` value in the workflow directory, with its file and line. */
function runsOnValues(): Array<{ file: string; line: number; value: string }> {
  return workflowFiles().flatMap(file =>
    fs
      .readFileSync(path.join(WORKFLOWS, file), 'utf-8')
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      // Only real keys: a `runs-on` inside a comment or prose is not a job.
      .filter(({ text }) => /^\s{2,}runs-on:\s*\S/.test(text))
      .map(({ text, line }) => ({
        file,
        line,
        value: text.replace(/^\s*runs-on:\s*/, '').trim(),
      }))
  );
}

describe('workflow runner selection honours the kill switch', () => {
  it('no job pins a self-hosted label set', () => {
    const pinned = runsOnValues().filter(
      r => r.value.includes('self-hosted') && !SANCTIONED.includes(r.value)
    );

    expect(
      pinned.map(r => `${r.file}:${r.line} → ${r.value}`),
      'these jobs demand self-hosted labels unconditionally, so `vars.USE_SELF_HOSTED=false` cannot move them. GitHub QUEUES a job whose labels match no online runner (up to ~24h) rather than failing it, and `timeout-minutes` only starts once a runner is assigned — so during a runner incident the job hangs and anything it was meant to report never arrives.'
    ).toEqual([]);
  });

  it('every runs-on is a sanctioned form, plain ubuntu-latest, or registered', () => {
    const unknown = runsOnValues().filter(
      r =>
        !SANCTIONED.includes(r.value) &&
        r.value !== 'ubuntu-latest' &&
        !(`${r.file}:${r.line}` in DELIBERATE)
    );

    expect(
      unknown.map(r => `${r.file}:${r.line} → ${r.value}`),
      'unrecognised `runs-on`. Use one of the sanctioned toggle forms, or `ubuntu-latest`, or register it in DELIBERATE with the reason.'
    ).toEqual([]);
  });

  it('actually reads the workflows — the walk is not silently empty', () => {
    // Without this, a renamed directory or a broken regex would make every
    // assertion above vacuous forever.
    expect(workflowFiles().length).toBeGreaterThan(10);
    expect(runsOnValues().length).toBeGreaterThan(20);
  });

  it('gitleaks notify-failure is on the toggle — it is the one that was pinned', () => {
    // The positive control, naming the specific regression.
    const gitleaks = runsOnValues().filter(r => r.file === 'gitleaks.yml');
    expect(gitleaks.length).toBeGreaterThanOrEqual(2);
    for (const r of gitleaks) {
      expect(SANCTIONED, `gitleaks.yml:${r.line} → ${r.value}`).toContain(r.value);
    }
  });
});
