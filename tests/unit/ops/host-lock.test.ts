import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/ci/host-lock.sh: the heavy pre-push test run is serialised host-wide and NEVER skipped.
const SCRIPT = join(__dirname, '../../../scripts/ci/host-lock.sh');
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  HOST_LOCK_DIR: dir,
  HOST_LOCK_POLL_S: '1',
  ...extra,
});

describe('host-lock.sh', () => {
  it('runs the command, passes its exit code through, and releases the lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    const ok = spawnSync('bash', [SCRIPT, 'a', 'sh', '-c', 'exit 0'], { env: env(dir) });
    const bad = spawnSync('bash', [SCRIPT, 'a', 'sh', '-c', 'exit 7'], { env: env(dir) });
    expect(ok.status).toBe(0);
    expect(bad.status).toBe(7);
    expect(existsSync(join(dir, 'a.lock'))).toBe(false);
  });

  it('a second run WAITS for the first (never overlaps, never skipped) and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    const log = join(dir, 'order.log');
    const first = spawn(
      'bash',
      [SCRIPT, 'b', 'sh', '-c', `echo first-start >> ${log}; sleep 3; echo first-end >> ${log}`],
      { env: env(dir) }
    );
    await new Promise(r => setTimeout(r, 700));
    let err = '';
    const second = spawn('bash', [SCRIPT, 'b', 'sh', '-c', `echo second >> ${log}`], {
      env: env(dir),
    });
    second.stderr.on('data', d => (err += d));
    const [c1, c2] = await Promise.all([
      new Promise(r => first.on('close', r)),
      new Promise(r => second.on('close', r)),
    ]);
    expect([c1, c2]).toEqual([0, 0]);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'first-start',
      'first-end',
      'second',
    ]);
    expect(err).toContain('holds the host lock');
  }, 20000);

  it('reclaims a lock whose holder died (a killed push must not wedge the queue)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    mkdirSync(join(dir, 'c.lock'));
    writeFileSync(join(dir, 'c.lock', 'pid'), '999999\n');
    const r = spawnSync('bash', [SCRIPT, 'c', 'echo', 'ran'], { env: env(dir) });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toContain('ran');
  });

  it('on timeout it FAILS (75) and does not run the command unlocked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-'));
    mkdirSync(join(dir, 'd.lock'));
    writeFileSync(join(dir, 'd.lock', 'pid'), `${process.pid}\n`); // a live holder: this test process
    const marker = join(dir, 'ran');
    const r = spawnSync('bash', [SCRIPT, 'd', 'touch', marker], {
      env: env(dir, { HOST_LOCK_MAX_WAIT_S: '2' }),
    });
    expect(r.status).toBe(75);
    expect(existsSync(marker)).toBe(false);
  }, 15000);

  it('the pre-push hook runs the unit suite through it with a worker cap', () => {
    const hook = readFileSync(join(__dirname, '../../../.husky/pre-push'), 'utf8');
    expect(hook).toContain(
      'scripts/ci/host-lock.sh ebda-unit-suite npm run test:unit -- --maxWorkers=50%'
    );
    expect(hook).not.toMatch(/^npm run test:unit$/m);
  });
});
