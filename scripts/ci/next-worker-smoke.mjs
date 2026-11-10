#!/usr/bin/env node
/**
 * Next-on-workerd boot smoke (Ruling DEP-OPENNEXT-PREVIEW-1). The deploy workflows probe the live
 * Worker after `wrangler deploy` and roll back on a 5xx, but the PR gate only ran `next build` +
 * `wrangler deploy --dry-run`, which never execute a request. #256 (next 16.3.8 -> 16.4.3) passed
 * both and then returned HTTP 500 on every request on web/admin/orders, because the OpenNext
 * adapter threw `Unexpected loadManifest(.../preview-props.json) call!` only at request time.
 *
 * Boots the already-built `.open-next/worker.js` of one app in local workerd and requests the SAME
 * paths + expected statuses the deploy probes use. Run after `bash scripts/cf-build.sh <app>`.
 *
 *   node scripts/ci/next-worker-smoke.mjs <web|admin|orders>
 */
import { spawn } from 'node:child_process';
import { existsSync, createWriteStream, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Paths + statuses mirror the `--probe` lines in .github/workflows/cf-{web,admin,orders}-deploy.yml.
 * `smokeOnly` entries run here and NOT after a deploy: [path, status, content-type prefix]. The web
 * app manifest is a hand-written route (Ruling PWA-MANIFEST-2), so nothing but a request to the built
 * Worker proves it is still served; for a host that is no store it answers the generic manifest.
 */
export const PROBES = {
  web: {
    port: 8811, host: 'ebda-deploy-probe.ebda.app', paths: [['/', 404]],
    smokeOnly: [['/manifest.webmanifest', 200, 'application/manifest+json']],
  },
  admin: { port: 8812, host: 'store.ebda.app', paths: [['/signup', 200], ['/login', 200]] },
  orders: { port: 8813, host: 'orders.ebda.app', paths: [['/login', 200]] },
};

async function main() {
  const app = process.argv[2];
  const cfg = PROBES[app];
  if (!cfg) throw new Error(`usage: next-worker-smoke.mjs <${Object.keys(PROBES).join('|')}>`);
  const dir = path.join(ROOT, 'apps', app);
  if (!existsSync(path.join(dir, '.open-next/worker.js'))) throw new Error(`apps/${app}/.open-next/worker.js missing - run scripts/cf-build.sh ${app} first`);

  // Boot the adapter's own `.open-next/worker.js` (where the request-time manifest loading lives), not
  // the deploy wrapper: web's Sentry/cache wrapper answers 500 in local workerd even on the last good
  // release (Next 16.3.8), so it cannot tell a regression from the local-dev limitation.
  const tmpCfg = path.join(dir, '.wrangler.smoke.jsonc');
  const src = readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  if (!/"main":\s*"[^"]+"/.test(src)) throw new Error('wrangler.jsonc has no "main"');
  writeFileSync(tmpCfg, src.replace(/"main":\s*"[^"]+"/, '"main": ".open-next/worker.js"'));

  const logFile = path.join(process.env.RUNNER_TEMP || tmpdir(), `next-worker-smoke-${app}.log`);
  const log = createWriteStream(logFile);
  const child = spawn(path.join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--config', tmpCfg, '--local', '--port', String(cfg.port), '--ip', '127.0.0.1'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  child.stdout.pipe(log); child.stderr.pipe(log);
  let exited = false; child.on('exit', () => { exited = true; });

  const failures = [];
  try {
    const base = `http://127.0.0.1:${cfg.port}`;
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !exited) {
      try { await fetch(`${base}/__smoke_ping`, { redirect: 'manual' }); up = true; break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!up) failures.push('wrangler dev did not start listening within 90s');
    else for (const [p, want, type] of [...cfg.paths, ...(cfg.smokeOnly ?? [])]) {
      const res = await fetch(base + p, { headers: { host: cfg.host }, redirect: 'manual' });
      const got = res.headers.get('content-type') ?? '';
      console.log(`${app} ${p} -> ${res.status} (want ${want})${type ? ` ${got} (want ${type})` : ''}`);
      if (res.status !== want) failures.push(`${p}: got ${res.status}, want ${want}`);
      else if (type && !got.startsWith(type)) failures.push(`${p}: content-type ${got || '(none)'}, want ${type}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!exited) child.kill('SIGKILL');
    log.end();
    rmSync(tmpCfg, { force: true });
  }
  if (failures.length) {
    console.error(`::error::${app} Worker smoke failed:\n  ${failures.join('\n  ')}\n--- worker log (${logFile}) ---`);
    console.error(readFileSync(logFile, 'utf8').split('\n').filter((l) => /error|Error|    at /.test(l)).slice(0, 40).join('\n'));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
