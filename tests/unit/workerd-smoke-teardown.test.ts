import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain .mjs without types
import { closeLog } from '../../scripts/ci/workerd-smoke.mjs';

// #207 (2026-10-25): the workerd smoke printed "workerd smoke OK" and then exited 1 with
// `ERR_STREAM_WRITE_AFTER_END` because the log file stream was ended while the killed child's pipes still delivered
// buffered output. Load-dependent, so it passed on retry and was misread as CI infra trouble.
const noisyChild = () =>
  spawn(
    process.execPath,
    [
      '-e',
      'setInterval(() => { process.stdout.write("x".repeat(65536)); process.stderr.write("y".repeat(65536)); }, 1)',
    ],
    { detached: true }
  );
// A log whose writes are SLOW (a loaded disk): `end()` then leaves the stream un-finished for a while, and the child's
// still-attached pipes write into that window. That is the load-dependent race.
const slowLog = () => {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        setTimeout(cb, 40);
      },
    }),
    chunks,
  };
};

describe('workerd smoke log teardown', () => {
  it('closeLog detaches BOTH pipes before ending the file (no stream is left that can write after end)', async () => {
    const child = noisyChild();
    const { stream: log } = slowLog();
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const pipes = (s: unknown) =>
      (s as { _readableState: { pipes: unknown[] } })._readableState.pipes.length;
    expect([pipes(child.stdout), pipes(child.stderr)]).toEqual([1, 1]);
    await new Promise(r => setTimeout(r, 200));
    closeLog(child, log as never);
    expect([pipes(child.stdout), pipes(child.stderr)]).toEqual([0, 0]);
    expect(log.writableEnded).toBe(true);
    process.kill(-child.pid!, 'SIGKILL');
  }, 20000);

  it('closeLog detaches the pipes first: a child still writing causes no error', async () => {
    const child = noisyChild();
    const { stream: log, chunks } = slowLog();
    const errors: unknown[] = [];
    log.on('error', e => errors.push(e));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const closed = new Promise(r => log.on('finish', r));
    await new Promise(r => setTimeout(r, 300));
    closeLog(child, log as never);
    await new Promise(r => setTimeout(r, 600)); // the child is STILL running and writing
    process.kill(-child.pid!, 'SIGKILL');
    await closed;
    expect(errors).toEqual([]);
    expect(chunks.length).toBeGreaterThan(0);
  }, 20000);

  it('the script itself swallows late stream errors and uses closeLog in its finally block', () => {
    const src = readFileSync(join(__dirname, '../../scripts/ci/workerd-smoke.mjs'), 'utf8');
    expect(src).toContain("log.on('error', () => {})");
    expect(src).toMatch(/finally \{\s*stop\(\);\s*closeLog\(child, log\);/);
    expect(src).not.toMatch(/log\.end\(\);\s*\}\s*if \(failure\)/);
  });
});

describe('CI service containers and npm settings (2026-10-25 root-cause fixes)', () => {
  const ci = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const deploy = readFileSync(join(__dirname, '../../.github/workflows/cf-api-deploy.yml'), 'utf8');
  it('every postgres healthcheck names the user and database (a bare pg_isready logs FATAL role "root" every 10 s and hides real failures)', () => {
    // N-17: cf-api-deploy.yml no longer has a Postgres service (the smoke needs none); ci.yml keeps them for Node tests.
    expect(deploy).not.toMatch(/pg_isready/);
    for (const [name, src] of [['ci.yml', ci]] as const) {
      const pg = [...src.matchAll(/--health-cmd (?:"(pg_isready[^"]*)"|(pg_isready)\b)/g)];
      expect(pg.length, `${name} has postgres service containers`).toBeGreaterThan(0);
      for (const m of pg) expect(m[1] ?? m[2], name).toMatch(/^pg_isready -U test -d \w+$/);
    }
  });
  it('npm uses the runner cache and skips audit/fund round-trips, with a bounded fetch', () => {
    for (const k of [
      'NPM_CONFIG_PREFER_OFFLINE',
      'NPM_CONFIG_AUDIT',
      'NPM_CONFIG_FUND',
      'NPM_CONFIG_FETCH_TIMEOUT',
      'NPM_CONFIG_FETCH_RETRIES',
    ])
      expect(ci).toContain(`${k}:`);
  });
});
