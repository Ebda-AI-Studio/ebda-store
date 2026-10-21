/**
 * Starts the local embed proxy (embed-proxy/worker.ts) for one eval run (`--real`), review M4.
 * - a random 32-byte secret per run, written to a 0600 file in a fresh 0700 temp dir and handed to
 *   wrangler as `--env-file` (never on argv, so not in `ps`; never committed; never printed);
 *   the dir is removed as soon as wrangler is ready, and again on stop;
 * - 127.0.0.1 only, on a free port picked by the OS;
 * - wrangler's own output is swallowed (only "Ready" is watched for), and the whole process group
 *   (npx → wrangler → workerd) is killed on stop or on process exit.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_SECRET_HEADER } from './embed-proxy/shared';

const CONFIG = fileURLToPath(new URL('./embed-proxy/wrangler.jsonc', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface EmbedProxy {
  embed(texts: string[]): Promise<number[][]>;
  stop(): void;
}

export async function startEmbedProxy(maxBatch: number): Promise<EmbedProxy> {
  const secret = randomBytes(32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'search-eval-proxy-'));
  const envFile = join(dir, 'proxy.env');
  writeFileSync(envFile, `EVAL_PROXY_SECRET=${secret}\n`, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '-c',
      CONFIG,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--env-file',
      envFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  );
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', stop);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error('embed proxy did not start within 90 s (is `wrangler login` done?)'));
    }, 90_000);
    const onData = (b: Buffer) => {
      if (/Ready on/.test(String(b))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`embed proxy exited before it was ready (code ${code})`));
    });
  });
  rmSync(dir, { recursive: true, force: true }); // wrangler has read it
  const url = `http://127.0.0.1:${port}/`;
  return {
    stop,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += maxBatch) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [EVAL_SECRET_HEADER]: secret },
          body: JSON.stringify({ text: texts.slice(i, i + maxBatch) }),
        });
        if (!res.ok) throw new Error(`embed proxy HTTP ${res.status}`);
        out.push(...((await res.json()) as { data: number[][] }).data);
      }
      return out;
    },
  };
}
