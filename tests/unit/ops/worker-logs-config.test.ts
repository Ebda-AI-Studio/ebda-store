import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// G7: every Ebda Worker keeps Workers Logs (observability, 100% sampling) and Workers Trace Events
// Logpush on. Logpush has no effect until the job exists (scripts/ops/cf-logs-setup.sh), but the
// per-script flag is the part a PR can lose silently, so it is pinned here.
const ROOT = join(__dirname, '../../..');
const WORKERS = [
  'api',
  'web',
  'admin',
  'marketing',
  'orders',
  'accounts',
  'help',
  'docs',
  'status',
] as const;

/** JSONC -> object: strips // and block comments outside strings, and trailing commas. */
function parseJsonc(src: string): Record<string, unknown> {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += src[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (!(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('Workers Logs + Logpush config (G7)', () => {
  for (const app of WORKERS) {
    it(`ebda-${app} has observability at 100% sampling and logpush on`, () => {
      const cfg = parseJsonc(readFileSync(join(ROOT, `apps/${app}/wrangler.jsonc`), 'utf8'));
      expect(cfg.name).toBe(`ebda-${app}`);
      expect(cfg.observability).toMatchObject({ enabled: true, head_sampling_rate: 1 });
      expect(cfg.logpush).toBe(true);
    });
  }

  it('the OpenNext generator (which overwrites web/admin/orders at deploy) emits both too', () => {
    const gen = readFileSync(join(ROOT, 'scripts/cf-setup-local.sh'), 'utf8');
    const blocks = gen.match(
      /"observability": \{ "enabled": true, "head_sampling_rate": 1 \},\n\s*"logpush": true/g
    );
    expect(blocks?.length).toBe(2);
    expect(gen).not.toMatch(/"observability": \{ "enabled": true \}\n/);
  });
});
