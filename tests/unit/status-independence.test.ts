/**
 * status.ebda.app must keep working when the platform is down, so apps/status is its own Worker
 * with its own storage and may not import (or be wired to) apps/api, the database package or any
 * app. The only allowed cross-package imports are the pure-data brand module and the studio 404 renderer
 * (a pure string-in/string-out function whose only import is that same brand module).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../apps/status/src');
const files = readdirSync(SRC).filter(f => f.endsWith('.ts'));

describe('apps/status independence', () => {
  it('scans the status Worker sources', () => {
    expect(files).toEqual(
      expect.arrayContaining(['index.ts', 'store.ts', 'probe.ts', 'config.ts'])
    );
  });

  it('imports nothing from apps/api, apps/*, @ebda/database or @ebda/api', () => {
    for (const f of files) {
      const src = readFileSync(path.join(SRC, f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
      for (const spec of imports) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(
          /apps\/(api|admin|web|orders|marketing)|@ebda\/(api|database|ui)\b/
        );
        if (spec.includes('packages/'))
          expect(spec, `${f}`).toMatch(/packages\/shared\/src\/(brand|studio-pages)\/index$/);
      }
    }
  });

  it('declares only its own Durable Object storage (no Hyperdrive/D1/KV/queues bindings)', () => {
    const cfg = readFileSync(path.resolve(__dirname, '../../apps/status/wrangler.jsonc'), 'utf8');
    expect(cfg).toContain('StatusStore');
    expect(cfg).not.toMatch(/hyperdrive|d1_databases|kv_namespaces|queues|services/i);
  });
});
