/**
 * #1535: the guest-checkout admission probe fired exactly one curl and
 * treated any non-404 as a fatal deploy failure. `paymentLimiter` is keyed
 * by IP with a shared self-hosted runner IP behind it, so a 429 RATE_LIMITED
 * is reachable on a genuinely healthy deploy, as is a transient 502/504
 * during the post-deploy replica swap — both used to fire notify-failure and
 * invite an unnecessary rollback of a release that actually shipped fine.
 *
 * This extracts the REAL "Verify guest checkout is still admitted" step
 * script from the workflow (not a reimplementation) and runs it against a
 * stateful curl stub, so the retry-vs-fatal classification is proven.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const WF_PATH = join(__dirname, '../../.github/workflows/railway-deploy.yml');
const doc = yaml.load(readFileSync(WF_PATH, 'utf8')) as Workflow;
const probeStep = doc.jobs?.deploy?.steps?.find(
  s => s.name === 'Verify guest checkout is still admitted'
);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Runs the extracted probe script against a scripted sequence of
 * {code, body} responses — one per curl invocation, the last one repeats if
 * the script calls curl more times than the sequence has entries.
 */
function runProbe(sequence: Array<{ code: string; body: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'admission-probe-'));
  dirs.push(dir);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);

  writeFileSync(join(binDir, 'sequence.json'), JSON.stringify(sequence));
  writeFileSync(join(binDir, 'call-count'), '0');

  // The stub: bump a call counter, pick the matching (or last) entry, write
  // its body to whatever `-o FILE` the real probe_args passed, print the code.
  const curlStub = `#!/usr/bin/env bash
n=$(cat "${binDir}/call-count")
n=$((n + 1))
echo "$n" > "${binDir}/call-count"
out_file=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out_file="$a"; fi
  prev="$a"
done
node -e '
  const fs = require("fs");
  const seq = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const n = Number(process.argv[2]);
  const entry = seq[Math.min(n - 1, seq.length - 1)];
  if (process.argv[3]) fs.writeFileSync(process.argv[3], entry.body);
  process.stdout.write(entry.code);
' "${binDir}/sequence.json" "$n" "$out_file"
`;
  writeFileSync(join(binDir, 'curl'), curlStub);
  chmodSync(join(binDir, 'curl'), 0o755);

  // Fast retries in the test — no need to actually wait 5s per attempt.
  const script = (probeStep!.run as string).replace(/sleep 5/g, 'sleep 0.01');
  const scriptPath = join(dir, 'probe.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(scriptPath, 0o755);

  return spawnSync('bash', [scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      API_BASE: 'http://x',
      RUNNER_TEMP: dir,
    },
  });
}

const notFound = { code: '404', body: JSON.stringify({ error: { code: 'ORDER_NOT_FOUND' } }) };
const rateLimited = { code: '429', body: JSON.stringify({ error: { code: 'RATE_LIMITED' } }) };
const badGateway = { code: '502', body: '' };
const csrf = { code: '403', body: JSON.stringify({ error: { code: 'CSRF_MISSING' } }) };
const connFailed = { code: '000', body: '' };

describe('railway-deploy.yml admission probe retry', () => {
  it('the step was found (guards against a rename silently disabling this suite)', () => {
    expect(probeStep?.run).toBeTruthy();
  });

  it('passes immediately on a 404', () => {
    const r = runProbe([notFound]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/attempt 1:/);
  });

  it('retries through a 429 RATE_LIMITED and then succeeds', () => {
    const r = runProbe([rateLimited, rateLimited, notFound]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/attempt 3:/);
  });

  it('retries through a transient 502 and then succeeds', () => {
    const r = runProbe([badGateway, notFound]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('retries through curl connection failure (code 000) and then succeeds', () => {
    const r = runProbe([connFailed, notFound]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('fails immediately on CSRF — does NOT retry a deterministic lockout', () => {
    const r = runProbe([csrf, notFound]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/locked out again/);
    // Only one attempt — it must not have retried into the 404.
    expect(r.stdout).toMatch(/attempt 1:/);
    expect(r.stdout).not.toMatch(/attempt 2:/);
  });

  it('fails after exhausting 5 attempts still rate-limited', () => {
    const r = runProbe([rateLimited]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/never reached a verifiable state after 5 attempts/);
    expect(r.stdout).toMatch(/attempt 5:/);
  });

  it('still fails immediately on a genuine non-retryable non-404 (e.g. a 400)', () => {
    // 5xx, 429 and 000 are all in the retry set, so use a code outside it to
    // prove a real, deterministic failure still exits fast rather than
    // retrying forever.
    const unexpected = {
      code: '400',
      body: JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }),
    };
    const r = runProbe([unexpected, notFound]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/attempt 1:/);
    expect(r.stdout).not.toMatch(/attempt 2:/);
  });
});
