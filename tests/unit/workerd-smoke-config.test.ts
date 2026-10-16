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
