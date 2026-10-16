import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { stripAiBinding } from '../../scripts/ci/workerd-smoke.mjs';

it('smoke config has no AI binding but keeps every other binding', () => {
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  expect(src).toMatch(/"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
  const out = stripAiBinding(src);
  expect(out).not.toMatch(/"ai":/);
  for (const key of [
    '"hyperdrive"',
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
