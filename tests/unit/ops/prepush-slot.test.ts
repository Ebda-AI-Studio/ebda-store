import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/ci/prepush-slot.sh (PREPUSH-5): the scanner run holds ONE of N slots, so at most N pushes run scanners at once
// and none of them touches the shared heavy-test lock. It never skips and never runs outside a slot.
const SCRIPT = join(__dirname, '../../../scripts/ci/prepush-slot.sh');
const env = (dir: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  PREPUSH_SLOT_DIR: dir,
  ...extra,
});
const fresh = () => mkdtempSync(join(tmpdir(), 'ps-'));

describe('prepush-slot.sh', () => {
  it('runs the command and passes its exit code through (including 75 from the command itself)', () => {
    const d = fresh();
    expect(spawnSync('bash', [SCRIPT, 'sh', '-c', 'exit 0'], { env: env(d) }).status).toBe(0);
    expect(spawnSync('bash', [SCRIPT, 'sh', '-c', 'exit 7'], { env: env(d) }).status).toBe(7);
    expect(spawnSync('bash', [SCRIPT, 'sh', '-c', 'exit 75'], { env: env(d) }).status).toBe(75);
  });

  it('with 2 slots, 2 runs overlap but a 3rd WAITS for a free slot and still runs', async () => {
    const d = fresh();
    const log = join(d, 'order.log');
    const job = (name: string, sleep: number) =>
      spawn(
        'bash',
        [
          SCRIPT,
          'sh',
          '-c',
          `echo ${name}-start >> ${log}; sleep ${sleep}; echo ${name}-end >> ${log}`,
        ],
        { env: env(d, { PREPUSH_SLOTS: '2' }) }
      );
    const a = job('a', 3);
    const b = job('b', 3);
    await new Promise(r => setTimeout(r, 1000));
    let err = '';
    const c = job('c', 0);
    c.stderr.on('data', x => (err += x));
    const codes = await Promise.all([a, b, c].map(p => new Promise(r => p.on('close', r))));
    expect(codes).toEqual([0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.indexOf('c-start')).toBeGreaterThan(
      Math.min(lines.indexOf('a-end'), lines.indexOf('b-end'))
    );
    expect(lines.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
    expect(err).toContain('slots busy');
  }, 20000);

  it('times out with 75 and never runs the command when every slot stays busy', async () => {
    const d = fresh();
    const log = join(d, 'ran.log');
    const holder = spawn('bash', [SCRIPT, 'sleep', '5'], { env: env(d, { PREPUSH_SLOTS: '1' }) });
    await new Promise(r => setTimeout(r, 1000));
    const r = spawnSync('bash', [SCRIPT, 'sh', '-c', `echo x > ${log}`], {
      env: env(d, { PREPUSH_SLOTS: '1', PREPUSH_SLOT_MAX_WAIT_S: '2' }),
    });
    expect(r.status).toBe(75);
    expect(spawnSync('test', ['-e', log]).status).not.toBe(0);
    holder.kill();
  }, 20000);
});
