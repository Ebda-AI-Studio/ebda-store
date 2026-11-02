import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/ci/host-lock.sh: the heavy pre-push test run is serialised host-wide on the ONE shared lock file
// (~/.claude/locks/heavy-test.lock, lockf/flock) and NEVER skipped.
const SCRIPT = join(__dirname, '../../../scripts/ci/host-lock.sh');
const env = (file: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  HOST_LOCK_FILE: file,
  ...extra,
});
const fresh = () => join(mkdtempSync(join(tmpdir(), 'hl-')), 'heavy-test.lock');

describe('host-lock.sh', () => {
  it('runs the command and passes its exit code through', () => {
    const f = fresh();
    expect(spawnSync('bash', [SCRIPT, 'sh', '-c', 'exit 0'], { env: env(f) }).status).toBe(0);
    expect(spawnSync('bash', [SCRIPT, 'sh', '-c', 'exit 7'], { env: env(f) }).status).toBe(7);
  });

  it('a second run WAITS for the first (never overlaps, never skipped) and says so', async () => {
    const f = fresh();
    const log = join(f, '..', 'order.log');
    const first = spawn(
      'bash',
      [SCRIPT, 'sh', '-c', `echo first-start >> ${log}; sleep 3; echo first-end >> ${log}`],
      { env: env(f) }
    );
    await new Promise(r => setTimeout(r, 800));
    let err = '';
    const second = spawn('bash', [SCRIPT, 'sh', '-c', `echo second >> ${log}`], { env: env(f) });
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
    expect(err).toContain('queues');
  }, 20000);

  it('interoperates with the manual rule: a holder taking the lock with lockf/flock directly blocks the hook', async () => {
    const f = fresh();
    const manual = process.platform === 'darwin' ? ['lockf', '-k', f] : ['flock', f];
    const holder = spawn(manual[0], [...manual.slice(1), 'sleep', '3'], { env: process.env });
    await new Promise(r => setTimeout(r, 800));
    const t0 = Date.now();
    const r = spawnSync('bash', [SCRIPT, 'echo', 'ran'], { env: env(f) });
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeGreaterThan(1500); // it had to wait for the manual holder
    holder.kill();
  }, 20000);

  it('a killed holder frees the lock (the kernel drops it)', async () => {
    const f = fresh();
    const holder = spawn('bash', [SCRIPT, 'sleep', '60'], { env: env(f) });
    await new Promise(r => setTimeout(r, 800));
    holder.kill('SIGKILL');
    spawnSync('pkill', ['-f', 'sleep 60']);
    await new Promise(r => setTimeout(r, 500));
    const r = spawnSync('bash', [SCRIPT, 'echo', 'ran'], {
      env: env(f, { HOST_LOCK_MAX_WAIT_S: '5' }),
    });
    expect(r.status).toBe(0);
  }, 20000);

  it('on timeout it FAILS (75) and does not run the command unlocked', async () => {
    const f = fresh();
    const marker = join(f, '..', 'ran');
    const holder = spawn('bash', [SCRIPT, 'sleep', '8'], { env: env(f) });
    await new Promise(r => setTimeout(r, 800));
    const r = spawnSync('bash', [SCRIPT, 'touch', marker], {
      env: env(f, { HOST_LOCK_MAX_WAIT_S: '2' }),
    });
    expect(r.status).toBe(75);
    expect(existsSync(marker)).toBe(false);
    holder.kill();
  }, 20000);

  it('MAC-LIGHT-1: the pre-push gate runs inside the host lock and keeps only the fast checks', () => {
    const hook = readFileSync(join(__dirname, '../../../.husky/pre-push'), 'utf8');
    const gate = readFileSync(join(__dirname, '../../../scripts/ci/pre-push-gate.sh'), 'utf8');
    expect(hook).toContain('bash scripts/ci/host-lock.sh bash scripts/ci/pre-push-gate.sh');
    for (const heavy of [
      'npm run lint',
      'tsc --noEmit',
      'npm run test:unit',
      'npm run build',
      'db:generate',
    ])
      expect(hook, `${heavy} must not run in the hook`).not.toMatch(
        new RegExp(`^\\s*(npm|npx)[^#\\n]*${heavy}`, 'm')
      );
    for (const heavy of [
      'npm run lint',
      'tsc --noEmit',
      'npm run test:unit',
      'npm run build',
      'db:generate',
    ])
      expect(gate, `${heavy} belongs to CI, not the Mac`).not.toMatch(
        new RegExp(`^\\s*(npm|npx)[^#\\n]*${heavy}`, 'm')
      );
    expect(gate).toContain('check-action-pins');
    expect(gate).toContain('gitleaks detect');
    // not re-entrant: a nested lock on the same file would wait on its own parent forever
    expect(gate).not.toMatch(/^\s*(bash\s+)?scripts\/ci\/host-lock\.sh/m);
  });
});
