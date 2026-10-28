import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Ruling CI-8 residual: ciSurface.eraseSubject erases by buyer key across ALL stores. On the Cloudflare
// (DO) path erasure must go through apps/api/src/lib/ci/erase.ts (store-scoped, proof-gated).
const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/api/src');
const eraseTs = path.join(api, 'lib/ci/erase.ts');
const surfaces = fs.readFileSync(path.join(api, 'cf/erasure/surfaces.ts'), 'utf8');
const runbook = fs.readFileSync(path.resolve(api, '../../../docs/runbooks/cutover-cf.md'), 'utf8');

describe('cutover: store-scoped CI erasure', () => {
  it('the runbook checklist names lib/ci/erase.ts', () => {
    expect(runbook).toContain('apps/api/src/lib/ci/erase.ts');
    expect(runbook).toMatch(/NOT `ciSurface\.eraseSubject`/);
  });

  // lib/ci/erase.ts arrives with PR #228. From the moment it exists in the tree the DO-side erasure
  // surface MUST use it; the test turns into a hard gate with no edit.
  it.skipIf(!fs.existsSync(eraseTs))(
    'the erasure surface imports lib/ci/erase and ciSurface does not erase by buyer key alone',
    () => {
      expect(surfaces).toMatch(/from ['"][./]*lib\/ci\/erase['"]/);
      const body = surfaces.slice(surfaces.indexOf('export function ciSurface'));
      const ci = body.slice(0, body.indexOf("name: 'media'"));
      expect(ci).toMatch(/eraseCi|erase\w*\(/);
      expect(ci).not.toMatch(/ci\.delete\(ciBuyerIndexKey\(s\.buyerKey\)\)/);
    }
  );
});
