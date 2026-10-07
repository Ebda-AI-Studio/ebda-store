import { describe, expect, it } from 'vitest';
import {
  currentVersionId,
  parseProbe,
  runProbe,
  verifyOrRollback,
  MIGRATION_WARNING,
} from '../../scripts/ci/deploy-guard.mjs';

type Res = { status: number; body?: string } | Error;

/** A scripted world: `serve(url, tick)` answers each probe; time only moves when the guard sleeps. */
function world(serve: (url: string, tick: number) => Res, opts: { rollbackCode?: number } = {}) {
  let t = 0;
  let tick = 0;
  const calls: string[][] = [];
  const errors: string[] = [];
  const deps = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      tick++;
    },
    log: () => {},
    error: (m: string) => errors.push(m),
    fetchProbe: async (url: string) => {
      const r = serve(url, tick);
      if (r instanceof Error) throw r;
      return { status: r.status, body: r.body ?? '' };
    },
    run: async (args: string[]) => {
      calls.push(args);
      return { code: opts.rollbackCode ?? 0, stdout: '', stderr: 'boom' };
    },
  };
  return { deps, calls, errors, setTick: (n: number) => (tick = n) };
}

const base = {
  name: 'ebda-api',
  previous: 'prev-v1',
  sha: 'new-sha',
  windowMs: 30_000,
  rollbackWindowMs: 30_000,
  intervalMs: 5_000,
  probes: ['https://x/health|200|commit=new-sha', 'https://x/api/v1/public/stores/nope|404'],
  rollbackProbes: ['https://x/health|200', 'https://x/api/v1/public/stores/nope|404'],
};
const ok = (sha: string) => ({ status: 200, body: JSON.stringify({ status: 'ok', commit: sha }) });

describe('currentVersionId', () => {
  it('takes the 100% version of the NEWEST deployment, whatever the list order', () => {
    const list = [
      { created_on: '2026-10-08T10:00:00Z', versions: [{ version_id: 'new', percentage: 100 }] },
      { created_on: '2026-10-07T10:00:00Z', versions: [{ version_id: 'old', percentage: 100 }] },
    ];
    expect(currentVersionId(list)).toBe('new');
  });
  it('is null for split traffic or an empty list (rollback target unknown)', () => {
    expect(currentVersionId([])).toBeNull();
    expect(
      currentVersionId([
        {
          created_on: 'a',
          versions: [
            { version_id: 'a', percentage: 50 },
            { version_id: 'b', percentage: 50 },
          ],
        },
      ])
    ).toBeNull();
  });
});

describe('parseProbe', () => {
  it('parses url|status|commit and rejects malformed specs', () => {
    expect(parseProbe('https://a/h|200|commit=abc')).toEqual({
      url: 'https://a/h',
      status: 200,
      commit: 'abc',
    });
    expect(() => parseProbe('a/h|200')).toThrow();
    expect(() => parseProbe('https://a/h|ok')).toThrow();
    expect(() => parseProbe('https://a/h|200|sha=abc')).toThrow();
    expect(() => parseProbe('https://a/h|200|commit=')).toThrow();
  });
});

describe('runProbe', () => {
  const w = (r: Res) => world(() => r).deps;
  it('a 5xx never matches, even when the probe expects that status', async () => {
    expect((await runProbe({ url: 'u', status: 500 }, w({ status: 500 }))).ok).toBe(false);
    expect((await runProbe({ url: 'u', status: 404 }, w({ status: 502 }))).ok).toBe(false);
  });
  it('unreachable is a failure, not a throw', async () => {
    expect((await runProbe({ url: 'u', status: 200 }, w(new Error('dns')))).ok).toBe(false);
  });
  it('a wrong status or a 200 that is not the awaited 404 fails', async () => {
    expect((await runProbe({ url: 'u', status: 404 }, w({ status: 200 }))).ok).toBe(false);
  });
  it('commit probes need JSON status ok AND the exact commit', async () => {
    const p = { url: 'u', status: 200, commit: 'abc' };
    expect((await runProbe(p, w(ok('abc')))).ok).toBe(true);
    expect((await runProbe(p, w(ok('old')))).ok).toBe(false);
    expect((await runProbe(p, w({ status: 200, body: '<html>' }))).ok).toBe(false);
    expect(
      (await runProbe(p, w({ status: 200, body: '{"status":"degraded","commit":"abc"}' }))).ok
    ).toBe(false);
  });
});

describe('verifyOrRollback', () => {
  it('healthy new build: exit 0, wrangler is never asked to roll back', async () => {
    const w = world(url => (url.endsWith('/health') ? ok('new-sha') : { status: 404 }));
    expect(await verifyOrRollback(base, w.deps)).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('waits out edge propagation: old commit for two rounds, then the new one passes', async () => {
    const w = world((url, tick) =>
      url.endsWith('/health') ? ok(tick < 2 ? 'old' : 'new-sha') : { status: 404 }
    );
    expect(await verifyOrRollback(base, w.deps)).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('the Ebda 2026-10-08 incident: every request 500s -> rolls back to the recorded version, confirms it, exits 1', async () => {
    const w = world((url, tick) => {
      // The new build 500s everywhere. Once `wrangler rollback` ran, the old version serves.
      const rolledBack = w.calls.length > 0;
      if (!rolledBack) return { status: 500 };
      return url.endsWith('/health') ? ok('old-sha') : { status: 404 };
    });
    const code = await verifyOrRollback(base, w.deps);
    expect(code).toBe(1);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].slice(0, 4)).toEqual(['rollback', 'prev-v1', '--name', 'ebda-api']);
    expect(w.calls[0]).toContain('--yes');
    expect(w.errors.join('\n')).toContain(MIGRATION_WARNING);
    expect(w.errors.join('\n')).toMatch(/rolled back to prev-v1 and that version is serving/);
  });

  it('a healthy /health on the WRONG commit for the whole window also rolls back', async () => {
    const w = world(url => (url.endsWith('/health') ? ok('old-sha') : { status: 404 }));
    expect(await verifyOrRollback(base, w.deps)).toBe(1);
    expect(w.calls).toHaveLength(1);
  });

  it('a 5xx on the SECOND probe alone (health fine) rolls back', async () => {
    const w = world((url, _t) => {
      if (w.calls.length > 0) return url.endsWith('/health') ? ok('x') : { status: 404 };
      return url.endsWith('/health') ? ok('new-sha') : { status: 500 };
    });
    expect(await verifyOrRollback(base, w.deps)).toBe(1);
    expect(w.calls).toHaveLength(1);
  });

  it('rollback runs but service stays down: exit 2', async () => {
    const w = world(() => ({ status: 500 }));
    expect(await verifyOrRollback(base, w.deps)).toBe(2);
    expect(w.calls).toHaveLength(1);
  });

  it('wrangler rollback itself failing: exit 2, error carries its output', async () => {
    const w = world(() => ({ status: 500 }), { rollbackCode: 1 });
    expect(await verifyOrRollback(base, w.deps)).toBe(2);
    expect(w.errors.join('\n')).toContain('wrangler rollback FAILED');
  });

  it('no recorded previous version: fails loudly with exit 2 and never calls wrangler', async () => {
    const w = world(() => ({ status: 500 }));
    expect(await verifyOrRollback({ ...base, previous: 'none' }, w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
    expect(w.errors.join('\n')).toMatch(/NOTHING to roll back to/);
  });
});

// ---------------------------------------------------------------------------------------------
// The CLI end to end: the real script, real curl, a real HTTP server standing in for production,
// and a fake `npx` standing in for wrangler (records its argv, flips the server when it is asked
// to roll back). Proves the wiring the pure tests cannot: argv, curl parsing, exit codes,
// $GITHUB_OUTPUT.
// ---------------------------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/ci/deploy-guard.mjs');
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach(s => s.close()));

function fakeWrangler(dir: string, listJson: string, flip: string) {
  const bin = path.join(dir, 'npx');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
case "$2" in
  deployments) echo '${listJson}' ;;
  rollback) touch "${flip}" ;;
esac
`
  );
  chmodSync(bin, 0o755);
}

async function listen(handler: (url: string) => number): Promise<{ port: number }> {
  const server = createServer((req, res) => {
    res.statusCode = handler(req.url ?? '');
    res.end(JSON.stringify({ status: 'ok', commit: 'new-sha' }));
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port };
}

const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string }>(resolve => {
    const child = spawn('node', [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (out += d));
    child.on('close', (code: number) => resolve({ code, out }));
  });

describe('deploy-guard CLI', () => {
  it('previous: reads the newest 100% version and writes it to $GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-'));
    const list = JSON.stringify([
      { created_on: '2026-10-01T00:00:00Z', versions: [{ version_id: 'v-old', percentage: 100 }] },
      { created_on: '2026-10-05T00:00:00Z', versions: [{ version_id: 'v-live', percentage: 100 }] },
    ]);
    fakeWrangler(dir, list, path.join(dir, 'flip'));
    const outFile = path.join(dir, 'gh-output');
    const r = spawnSync('node', [SCRIPT, 'previous', '--name', 'ebda-api'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: outFile },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toBe('previous=v-live\n');
    expect(readFileSync(path.join(dir, 'calls.log'), 'utf8')).toContain(
      'wrangler deployments list --name ebda-api --json'
    );
  });

  it('verify: 500s until `wrangler rollback v-live` runs, then serves -> rolled back, exit 1', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-'));
    const flip = path.join(dir, 'flip');
    fakeWrangler(dir, '[]', flip);
    const { port } = await listen(() => (existsSync(flip) ? 200 : 500));
    const r = await run(
      [
        'verify',
        '--name',
        'ebda-api',
        '--previous',
        'v-live',
        '--sha',
        'new-sha',
        '--window',
        '1',
        '--rollback-window',
        '5',
        '--interval',
        '1',
        '--probe',
        `http://127.0.0.1:${port}/health|200`,
        '--rollback-probe',
        `http://127.0.0.1:${port}/health|200`,
      ],
      { PATH: `${dir}:${process.env.PATH}` }
    );
    expect(r.code).toBe(1);
    expect(readFileSync(path.join(dir, 'calls.log'), 'utf8')).toMatch(
      /wrangler rollback v-live --name ebda-api --message .* --yes/
    );
    expect(r.out).toContain('does NOT undo database migrations');
  }, 30_000);

  it('verify: a healthy deploy exits 0 and never touches wrangler', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-'));
    fakeWrangler(dir, '[]', path.join(dir, 'flip'));
    const { port } = await listen(() => 200);
    const r = await run(
      [
        'verify',
        '--name',
        'ebda-api',
        '--previous',
        'v-live',
        '--window',
        '5',
        '--interval',
        '1',
        '--probe',
        `http://127.0.0.1:${port}/health|200|commit=new-sha`,
      ],
      { PATH: `${dir}:${process.env.PATH}` }
    );
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, 'calls.log'))).toBe(false);
  }, 30_000);
});
