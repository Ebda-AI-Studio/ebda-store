import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { stripAiBinding } from '../../scripts/ci/workerd-smoke.mjs';

it('smoke config has no AI binding but keeps every other binding', () => {
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  expect(src).toMatch(/"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
  const out = stripAiBinding(src);
  expect(out).not.toMatch(/"ai":/);
  for (const key of [
    '"kv_namespaces"',
    '"durable_objects"',
    '"services"',
    '"queues"',
    '"ratelimits"',
    '"triggers"',
    '"alias"',
    '"vars"',
  ])
    expect(out).toContain(key);
  // Only the one line goes: everything else is byte-identical.
  expect(src.split('\n').length - out.split('\n').length).toBe(1);
});

it('a config with no AI block is refused, so a renamed/reshaped block cannot slip through', () => {
  expect(() => stripAiBinding('{ "name": "x" }')).toThrow(/no "ai" binding/);
});

// Review M5: with the AI binding, a plain `wrangler dev` opens a remote proxy session and fails to
// start without a Cloudflare login (measured 2026-10-16). Local dev boots a stripped copy instead.
it('local dev (cf:dev, the Stage 1 exit runner) boots a copy of the config without the AI binding', async () => {
  const pkg = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
  expect(pkg.scripts['cf:dev']).toMatch(
    /node \.\.\/\.\.\/scripts\/cf-api-local-config\.mjs && wrangler dev --config \.wrangler\.local\.jsonc/
  );
  expect(pkg.scripts['cf:dev:ai']).toBe('wrangler dev');
  const exitRun = readFileSync('apps/api/scripts/stage1-exit-run.sh', 'utf8');
  expect(exitRun).toMatch(/cf-api-local-config\.mjs/);
  expect(exitRun).toMatch(/wrangler dev [^\n]*--config \.wrangler\.local\.jsonc/);
  expect(readFileSync('.gitignore', 'utf8')).toMatch(/^apps\/api\/\.wrangler\.local\.jsonc$/m);
  const { localDevConfig } = await import('../../scripts/cf-api-local-config.mjs');
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  expect(localDevConfig(src)).toBe(stripAiBinding(src));
});

// PR3 final review I1: EVERY script that runs `wrangler dev` (not just cf:dev and the Stage 1 exit
// runner) boots a config without the AI binding, or it cannot start without a Cloudflare login.
it('every shell/node script that runs `wrangler dev` uses a config without the AI binding', () => {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const files = execSync(
    "git grep -l -E \"wrangler dev|'wrangler', 'dev'\" -- 'scripts/*.sh' 'scripts/**/*.sh' 'apps/api/scripts/*.sh' 'scripts/**/*.mjs' 'apps/api/scripts/*.mjs'",
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean);
  // An invocation, not a mention: `npx wrangler dev …` / `&& wrangler dev …` in shell, or a spawn
  // argument list `['wrangler', 'dev', …]` in node.
  const INVOKE = /(npx\s+wrangler\s+dev\b|(^|&&|;)\s*wrangler\s+dev\b|\['wrangler',\s*'dev')/;
  const STRIPPED = /\.wrangler\.(local|smoke)\.jsonc/;
  const offenders: string[] = [];
  let invocations = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const line of src.split('\n')) {
      if (/^\s*(#|\/\/|\*)/.test(line) || !INVOKE.test(line)) continue;
      invocations++;
      if (!STRIPPED.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
    }
    if (
      /\.wrangler\.local\.jsonc/.test(src) &&
      INVOKE.test(src) &&
      !/cf-api-local-config\.mjs/.test(src)
    )
      offenders.push(`${f}: uses .wrangler.local.jsonc without generating it`);
  }
  expect(invocations).toBeGreaterThanOrEqual(3); // smoke, stage1 exit runner, cf:dev (dev-api MODE=worker and parity-as-app went in NZ-17 slice 2)
  expect(offenders).toEqual([]);
});
