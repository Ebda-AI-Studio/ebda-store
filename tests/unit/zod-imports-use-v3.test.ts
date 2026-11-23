/**
 * Ruling ITEST-11: the repo's schemas are written against the zod 3 API, which zod 4 ships at `zod/v3`. A bare
 * `from 'zod'` now yields the v4 API (no `.errors`, different error shapes), so new code must import `zod/v3`
 * until a deliberate migration. The one allowed bare import is the regression test that exercises v4 on purpose.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ALLOWED = new Set([
  // The WhatsApp contract is byte-pinned (sha256) to the Ebda Chat product's copy, which imports bare 'zod':
  // this repo cannot rewrite it alone. Its schemas are plain z.object / z.enum, so v4 behaves the same here.
  'apps/api/src/contracts/wa-v1.ts',
  // The vendored @ebda/foundation capability schema is byte-pinned (sha256, foundation-parity test) and written against
  // the zod 4 API on purpose: it is a shared module with Ebda Chat, so this repo cannot rewrite it alone.
  'packages/shared/src/foundation/capability.ts',
  // Same for the vendored foundation contracts (F5, byte-pinned, shared with Ebda Chat): plain z.object / z.enum, so v4 behaves the same here.
  'packages/shared/src/foundation/contracts/wa-v1.ts',
  'tests/unit/zod-huge-array-bounds.test.ts',
  'tests/unit/zod-imports-use-v3.test.ts',
]);

// an import / export from 'zod', or a require('zod') binding (comments that merely mention it do not count)
const BARE_ZOD = String.raw`^[[:space:]]*(import|export)[[:space:]].*from ['"]zod['"]|^[[:space:]]*(const|let|var)[[:space:]].*require\(['"]zod['"]\)`;

describe('zod imports', () => {
  it("no tracked source file imports bare 'zod' (use 'zod/v3')", () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-lE', BARE_ZOD, '--', '*.ts', '*.tsx', '*.mjs', '*.js'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch {
      out = ''; // git grep exits 1 on no match
    }
    const offenders = out.split('\n').filter(f => f && !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});
