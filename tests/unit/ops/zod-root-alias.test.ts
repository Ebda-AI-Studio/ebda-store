import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as realZod from 'zod';
import * as shim from '../../../apps/api/src/cf/stubs/zod-root';

// Ruling BUNDLE-BUDGET-9: wrangler.jsonc aliases exactly `zod` to apps/api/src/cf/stubs/zod-root.ts, because
// `import { z } from 'zod'` (contracts/wa-v1.ts, byte-pinned) made esbuild keep all 64 zod locales in worker.js.
// This pins the wiring and that the stub is the real zod minus `locales`/`core` on `z`. That the BUILT worker.js sheds the
// locales is enforced on the real wrangler build by scripts/ci/worker-startup-budget.mjs (BANNED_BUNDLE_INPUTS, CI: Worker dry-run (api)).
const API = join(__dirname, '../../../apps/api');

describe('zod root alias for the Workers bundle', () => {
  it('wrangler.jsonc aliases exactly `zod` to the stub, which exists', () => {
    const wrangler = readFileSync(join(API, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toMatch(/"zod":\s*"\.\/src\/cf\/stubs\/zod-root\.ts"/);
    expect(wrangler).not.toMatch(/"zod\/v[34]":/);
    expect(existsSync(join(API, 'src/cf/stubs/zod-namespace.ts'))).toBe(true);
  });

  it('named exports are the real zod ones (same classes), and `z` is zod minus locales/core', () => {
    expect(shim.ZodOptional).toBe(realZod.ZodOptional);
    expect(shim.object).toBe(realZod.object);
    const realKeys = Object.keys(realZod.z).filter(k => k !== 'locales' && k !== 'core');
    for (const k of realKeys)
      expect((shim.z as Record<string, unknown>)[k], k).toBe(
        (realZod.z as Record<string, unknown>)[k]
      );
    expect((shim.z as Record<string, unknown>).locales).toBeUndefined();
    expect((shim.z as Record<string, unknown>).core).toBeUndefined();
    expect(shim.default).toBe(shim.z);
  });

  it('error messages stay English through the stub', () => {
    const viaShim = shim.z.object({ a: shim.z.string() }).safeParse({ a: 1 });
    const viaReal = realZod.z.object({ a: realZod.z.string() }).safeParse({ a: 1 });
    expect(viaShim.success).toBe(false);
    expect(viaShim.error?.issues[0]?.message).toBe(viaReal.error?.issues[0]?.message);
    expect(viaShim.error?.issues[0]?.message).toMatch(/^Invalid input: expected string/);
  });

  it('nothing in apps/api/src reads `z.locales` or `z.core` (undefined through the stub)', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (p !== join(API, 'src/cf/stubs')) walk(p);
        } else if (
          /\.(ts|mts|js|mjs)$/.test(e.name) &&
          /\bz\.(locales|core)\b/.test(readFileSync(p, 'utf8'))
        )
          offenders.push(p);
      }
    };
    walk(join(API, 'src'));
    expect(offenders).toEqual([]);
  });
});
